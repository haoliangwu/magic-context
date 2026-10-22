#!/usr/bin/env bun
import { mkdtempSync, rmSync, statSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "queued-drops-"));
process.env.NODE_ENV = "test";
process.env.MAGIC_CONTEXT_TEST_DATA_DIR = root;
process.env.XDG_DATA_HOME = root;
process.env.MAGIC_CONTEXT_STORAGE_DIR = root;
const { Database } = await import("@magic-context/core/shared/sqlite");
const { initializeDatabase } = await import(
	"@magic-context/core/features/magic-context/storage-db"
);
const { runMigrations } = await import(
	"@magic-context/core/features/magic-context/migrations"
);
const { getTagsBySession, queuePendingOp } = await import(
	"@magic-context/core/features/magic-context/storage"
);
const { applyPendingOperations } = await import(
	"@magic-context/core/hooks/magic-context/apply-operations"
);
const { history, project, seedHistory, session } = await import(
	"./queued-drops-fixture"
);
const repeats = Number(process.env.DROP_REPEATS ?? 20);
const nativeAuthorization = process.env.DROP_NATIVE_AUTH === "1";
const hosts = (process.env.DROP_HOSTS ?? "pi,oc1,oc2").split(",") as (
	| "pi"
	| "oc1"
	| "oc2"
)[];
console.log(`Bun ${Bun.version}; ${repeats * hosts.length * 3} drain checks`);
try {
	for (const host of hosts) {
		const path = join(root, `${host}.db`);
		const db = new Database(path);
		initializeDatabase(db);
		runMigrations(db);
		seedHistory(db);
		for (const count of [50, 160, 500]) {
			const samples = [];
			for (let run = 0; run < repeats; run++) {
				db.transaction(() => {
					db.prepare("DELETE FROM tags WHERE session_id = ?").run(session);
					db.prepare("DELETE FROM pending_ops WHERE session_id = ?").run(
						session,
					);
					db.prepare("DELETE FROM session_meta WHERE session_id = ?").run(
						session,
					);
				}).immediate();
				const raw = history(host, count);
				const tagged = project(host, raw, db, nativeAuthorization);
				const tools = getTagsBySession(db, session).filter(
					(t) => t.type === "tool",
				);
				db.transaction(() => {
					for (const t of tools)
						queuePendingOp(db, session, t.tagNumber, "drop");
				}).immediate();
				let commits = 0,
					commitMs = 0,
					maxLockMs = 0,
					lockStart = 0;
				const exec = db.exec.bind(db);
				db.exec = ((sql: string) => {
					const start = performance.now();
					const result = exec(sql);
					if (sql === "BEGIN IMMEDIATE") lockStart = performance.now();
					if (sql === "COMMIT") {
						commits++;
						commitMs += performance.now() - start;
						maxLockMs = Math.max(maxLockMs, performance.now() - lockStart);
					}
					return result;
				}) as typeof db.exec;
				writeSync(1, `DRAIN-BEGIN ${host} ${count} ${run}\n`);
				const start = performance.now();
				applyPendingOperations(session, db, tagged.targets, new Set());
				tagged.commit();
				const elapsedMs = performance.now() - start;
				writeSync(1, `DRAIN-END ${host} ${count} ${run}\n`);
				db.exec = exec;
				if (
					getTagsBySession(db, session).filter((t) => t.status === "dropped")
						.length !== count
				)
					throw new Error("drop count mismatch");
				samples.push({ elapsedMs, commits, commitMs, maxLockMs });
			}
			const p95 = (key: "elapsedMs" | "maxLockMs") =>
				samples.map((s) => s[key]).sort((a, b) => a - b)[
					Math.ceil(repeats * 0.95) - 1
				];
			console.log(
				JSON.stringify({
					host,
					nativeAuthorization,
					count,
					dbBytes: statSync(path).size,
					journal: db.prepare("PRAGMA journal_mode").get(),
					synchronous: db.prepare("PRAGMA synchronous").get(),
					p95Ms: p95("elapsedMs"),
					p95LockMs: p95("maxLockMs"),
					samples,
				}),
			);
		}
		db.close();
	}
} finally {
	rmSync(root, { recursive: true, force: true });
}
