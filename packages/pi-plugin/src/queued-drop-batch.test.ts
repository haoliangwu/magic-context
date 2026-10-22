import { expect, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	getPendingOps,
	getTagsBySession,
	queuePendingOp,
} from "@magic-context/core/features/magic-context/storage";
import {
	applyFlushedStatuses,
	applyPendingOperations,
} from "@magic-context/core/hooks/magic-context/apply-operations";
import { createTestTempDirFromPath } from "@magic-context/core/shared/test-temp-dir";
import {
	history,
	project,
	seedHistory,
	session,
} from "../scripts/experiments/perf/queued-drops-fixture";
import { createTestDb } from "./test-utils.test";

for (const host of ["pi", "oc1", "oc2"] as const) {
	test(`queued batch ${host}: 160 drops have three bounded commits and stay below 300ms`, () => {
		const root = createTestTempDirFromPath(join(tmpdir(), "queued-count-"));
		const db = createTestDb(join(root, "fixture.db"));
		try {
			seedHistory(db);
			const raw = history(host, 160);
			const tagged = project(host, raw, db, host === "pi");
			db.transaction(() => {
				for (const t of getTagsBySession(db, session).filter(
					(t) => t.type === "tool",
				))
					queuePendingOp(db, session, t.tagNumber, "drop");
			}).immediate();
			const exec = db.exec.bind(db);
			let commits = 0;
			db.exec = ((sql: string) => {
				const result = exec(sql);
				if (sql === "COMMIT") commits++;
				return result;
			}) as typeof db.exec;
			const start = performance.now();
			expect(
				applyPendingOperations(session, db, tagged.targets, new Set()),
			).toBe(true);
			tagged.commit();
			const elapsed = performance.now() - start;
			expect(commits).toBe(3);
			expect(elapsed).toBeLessThan(300);
			expect(getPendingOps(db, session)).toEqual([]);
			expect(
				getTagsBySession(db, session).filter((t) => t.status === "dropped"),
			).toHaveLength(160);
		} finally {
			db.close();
			rmSync(root, { recursive: true, force: true });
		}
	}, 30_000);

	test(`queued batch ${host}: SIGKILL before first wire mutation replays committed drops exactly once`, () => {
		const root = createTestTempDirFromPath(join(tmpdir(), "queued-crash-"));
		const path = join(root, "fixture.db");
		let db = createTestDb(path);
		const reference = createTestDb();
		try {
			const raw = history(host, 50, 3);
			const expected = structuredClone(raw);
			const original = project(host, raw, db);
			original.commit();
			const uninterrupted = project(host, expected, reference);
			for (const connection of [db, reference])
				connection
					.transaction(() => {
						for (const t of getTagsBySession(connection, session).filter(
							(t) => t.type === "tool",
						))
							queuePendingOp(connection, session, t.tagNumber, "drop");
					})
					.immediate();
			applyPendingOperations(
				session,
				reference,
				uninterrupted.targets,
				new Set(),
			);
			uninterrupted.commit();
			db.close();
			const input = join(root, "raw.json");
			writeFileSync(input, JSON.stringify(raw));
			const child = join(root, "crash.ts");
			const module = (path: string) =>
				JSON.stringify(new URL(path, import.meta.url).pathname);
			writeFileSync(
				child,
				`
import { readFileSync, writeSync } from 'node:fs';
import { Database } from ${module("../../plugin/src/shared/sqlite.ts")};
import { applyPendingOperations } from ${module("../../plugin/src/hooks/magic-context/apply-operations.ts")};
import { project, session } from ${module("../scripts/experiments/perf/queued-drops-fixture.ts")};
const db = new Database(${JSON.stringify(path)});
const raw = JSON.parse(readFileSync(${JSON.stringify(input)}, 'utf8'));
const live = project(${JSON.stringify(host)}, raw, db);
for (const target of live.targets.values()) {
  for (const method of ['drop', 'skeletonReal', 'skeletonStripped', 'editMarker', 'editMarkerStripped', 'setContent']) {
    if (typeof target[method] === 'function') target[method] = () => {
      writeSync(1, 'FIRST-WIRE-MUTATION\\n');
      process.kill(process.pid, 'SIGKILL');
      throw new Error('SIGKILL did not terminate');
    };
  }
}
applyPendingOperations(session, db, live.targets, new Set());
throw new Error('No mutation boundary reached');
`,
			);
			const result = Bun.spawnSync([process.execPath, child], {
				windowsHide: true,
				env: {
					...process.env,
					RUSTC_WRAPPER: "",
					CARGO_BUILD_RUSTC_WRAPPER: "",
				},
			});
			expect(result.signalCode).toBe("SIGKILL");
			expect(result.stdout.toString()).toContain("FIRST-WIRE-MUTATION");
			db = createTestDb(path);
			expect(getPendingOps(db, session)).toEqual([]);
			expect(
				getTagsBySession(db, session).filter((t) => t.status === "dropped"),
			).toHaveLength(50);
			const replay = project(host, raw, db);
			expect(applyFlushedStatuses(session, db, replay.targets)).toBe(true);
			expect(
				applyPendingOperations(session, db, replay.targets, new Set()),
			).toBe(false);
			replay.commit();
			expect(raw).toEqual(expected);
			const bytes = JSON.stringify(raw);
			const again = project(host, raw, db);
			applyFlushedStatuses(session, db, again.targets);
			again.commit();
			expect(JSON.stringify(raw)).toBe(bytes);
		} finally {
			db.close();
			reference.close();
			rmSync(root, { recursive: true, force: true });
		}
	}, 30_000);
}
