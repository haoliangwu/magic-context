#!/usr/bin/env bun
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateSyntheticFixture } from "./fixtures";
import { createDatabaseTimer } from "./instrumentation";

// Every input is synthetic; never accept a path to a host's session or store.
const root = mkdtempSync(join(tmpdir(), "pi-long-session-"));
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
const { setHarness } = await import("@magic-context/core/shared/harness");
const { createTagger } = await import(
	"@magic-context/core/features/magic-context/tagger"
);
const { tagTranscript } = await import(
	"@magic-context/core/shared/tag-transcript"
);
const { applyPendingOperations } = await import(
	"@magic-context/core/hooks/magic-context/apply-operations"
);
const { createPiTranscript } = await import("../../../src/transcript-pi");
const { getPiTagSnapshotView, readPiFallbackTagRows } = await import(
	"../../../src/tag-snapshot-pi"
);
setHarness("pi");
const raw = new Database(join(root, "context.db"));
initializeDatabase(raw);
runMigrations(raw);
const timer = createDatabaseTimer(raw);
const db = timer.database;
const sessionId = "pi-long-session";

try {
	const fixture = generateSyntheticFixture({
		messages: 100_000,
		toolResultRepeat: 1500,
	});
	const visible = fixture.entries
		.slice(-6000)
		.filter((e) => e.type === "message");
	const messages = visible.map((e) =>
		structuredClone((e as unknown as { message: unknown }).message),
	);
	const transcript = createPiTranscript(
		messages as never,
		sessionId,
		visible.map((e) => e.id),
	);
	const tagger = createTagger();
	tagger.initFromDb(sessionId, db);
	const tagged = tagTranscript(sessionId, transcript, tagger, db);
	const existing = (
		raw
			.prepare("SELECT MAX(tag_number) AS n FROM tags WHERE session_id = ?")
			.get(sessionId) as { n: number }
	).n;
	const insert = raw.prepare(
		"INSERT INTO tags(session_id,tag_number,message_id,type,status,byte_size,tool_owner_message_id,tool_name) VALUES(?,?,?,?,'compacted',4000,?,?)",
	);
	raw
		.transaction(() => {
			for (let n = existing + 1; n <= 200_000; n++) {
				const tool = n % 3 !== 0;
				insert.run(
					sessionId,
					n,
					tool ? `history-call-${n}` : `history-${n}:p0`,
					tool ? "tool" : "message",
					tool ? `history-owner-${n}` : null,
					tool ? "read" : null,
				);
			}
		})
		.immediate();
	const stages: Record<string, number> = {};
	const measure = (name: string, run: () => unknown) => {
		const start = performance.now();
		run();
		stages[name] = performance.now() - start;
	};
	timer.reset();
	measure("coldTagSnapshotSync", () => readPiFallbackTagRows(db, sessionId));
	measure("warmTagSnapshotSync", () => readPiFallbackTagRows(db, sessionId));
	const snapshotSql = timer.queries().slice(0, 6);
	const tools = raw
		.prepare(
			"SELECT tag_number AS n FROM tags WHERE session_id = ? AND type = 'tool' AND status = 'active' ORDER BY tag_number",
		)
		.all(sessionId) as { n: number }[];
	const queue = raw.prepare(
		"INSERT INTO pending_ops(session_id,tag_id,operation,queued_at,harness) VALUES(?,?,'drop',?,'pi')",
	);
	raw
		.transaction(() => {
			for (const { n } of tools) queue.run(sessionId, n, n);
		})
		.immediate();
	let wireMs = 0;
	const targets = new Map(
		[...tagged.targets].map(([n, target]) => [
			n,
			new Proxy(target, {
				get(object, key) {
					const value = Reflect.get(object, key);
					if (typeof value !== "function") return value;
					return (...args: unknown[]) => {
						const start = performance.now();
						try {
							return value.apply(object, args);
						} finally {
							wireMs += performance.now() - start;
						}
					};
				},
			}),
		]),
	);
	let admissionMs = 0,
		commitMs = 0,
		admissions = 0,
		commits = 0,
		lockStart = 0,
		maxLockMs = 0;
	const exec = raw.exec.bind(raw);
	raw.exec = ((sql: string) => {
		const start = performance.now();
		const result = exec(sql);
		if (/^BEGIN IMMEDIATE/.test(sql)) {
			admissionMs += performance.now() - start;
			admissions++;
			lockStart = performance.now();
		}
		if (sql === "COMMIT") {
			commitMs += performance.now() - start;
			commits++;
			maxLockMs = Math.max(maxLockMs, performance.now() - lockStart);
		}
		return result;
	}) as typeof raw.exec;
	timer.reset();
	measure("applyPendingOperations", () =>
		applyPendingOperations(sessionId, db, targets, new Set()),
	);
	const sql = timer.snapshot();
	const operationsSql = timer.queries().slice(0, 6);
	const dropped = raw
		.prepare(
			"SELECT COUNT(*) AS n FROM tags WHERE session_id = ? AND status = 'dropped'",
		)
		.get(sessionId) as { n: number };
	if (dropped.n !== tools.length)
		throw new Error(`Expected ${tools.length} drops, got ${dropped.n}`);
	measure("postOperationSnapshotSync", () =>
		getPiTagSnapshotView(db, sessionId),
	);
	console.log(
		JSON.stringify({
			bun: Bun.version,
			entries: fixture.entries.length,
			fixtureBytes: fixture.sourceBytes,
			tags: 200_000,
			operations: tools.length,
			checks: 1,
			stages,
			perOp: {
				admissionMs: admissionMs / tools.length,
				sqlMs: sql.elapsedMs / tools.length,
				commitMs: commitMs / tools.length,
				wireMs: wireMs / tools.length,
			},
			admissions,
			commits,
			maxLockMs,
			snapshotSql,
			operationsSql,
		}),
	);
} finally {
	raw.close();
	rmSync(root, { recursive: true, force: true });
}
