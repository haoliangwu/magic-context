// Bundle this file and tag-snapshot-worker-pi.ts with --target node --splitting
// into the same scratch directory, then run node --test tag-snapshot-node.test.js.
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runMigrations } from "@magic-context/core/features/magic-context/migrations";
import { initializeDatabase } from "@magic-context/core/features/magic-context/storage-db";
import { getTagsBySession } from "@magic-context/core/features/magic-context/storage-tags";
import {
	Database,
	detectSqliteRuntime,
} from "@magic-context/core/shared/sqlite";
import { createTestTempDirFromPath } from "../../plugin/src/shared/test-temp-dir";
import { PiContextBudget } from "./pi-context-budget";
import {
	__setPiTagSnapshotWorkerForTests,
	drainPiTagSnapshotSession,
	ensurePiTagSnapshotReady,
	getPiTagSnapshotView,
} from "./tag-snapshot-pi";
import { startPiTagSnapshotWorker } from "./tag-snapshot-worker-client-pi";

console.log(
	`Pi hydration checks: ${process.version}, ${detectSqliteRuntime()}`,
);

function fixture() {
	const root = createTestTempDirFromPath(join(tmpdir(), "pi-hydration-node-"));
	const path = join(root, "context.db");
	const db = new Database(path);
	initializeDatabase(db);
	runMigrations(db);
	const writer = new Database(path);
	initializeDatabase(writer);
	const insert = writer.prepare(`INSERT INTO tags
		(session_id, tag_number, message_id, type, status, byte_size)
		VALUES ('node-session', ?, ?, 'message', 'active', 10)`);
	writer.transaction(() => {
		for (let n = 1; n <= 768; n++) insert.run(n, `pi-msg-${n}:p0`);
	})();
	return {
		db,
		writer,
		path,
		async close() {
			await drainPiTagSnapshotSession("node-session");
			writer.close();
			db.close();
			rmSync(root, { recursive: true, force: true });
		},
	};
}

test("Node hydration publishes despite cross-session commits at every credit", async () => {
	const h = fixture();
	try {
		let writes = 0;
		let starts = 0;
		__setPiTagSnapshotWorkerForTests(h.db, (request, cached) => {
			starts++;
			return startPiTagSnapshotWorker(request, {
				cached,
				beforeAck: async () => {
					h.writer
						.prepare(`INSERT INTO tags(session_id, tag_number, message_id, type, status, byte_size)
					VALUES ('other', ?, 'other', 'message', 'active', 10)`)
						.run(++writes);
				},
			});
		});
		await ensurePiTagSnapshotReady(h.db, "node-session", new PiContextBudget());
		assert.equal(starts, 1);
		assert.ok(writes >= 8);
		assert.deepEqual(
			getPiTagSnapshotView(h.db, "node-session"),
			getTagsBySession(h.db, "node-session"),
		);
	} finally {
		await h.close();
	}
});

test("Node hydration discards three stale prefixes and restarts at tag one", async () => {
	const h = fixture();
	try {
		let starts = 0;
		__setPiTagSnapshotWorkerForTests(h.db, (request, cached) => {
			const attempt = ++starts;
			let changed = false;
			return startPiTagSnapshotWorker(request, {
				cached,
				beforeAck: async (message) => {
					if (message.type !== "packet" || changed || attempt > 3) return;
					changed = true;
					h.writer.exec(
						"UPDATE tags SET byte_size = byte_size + 1 WHERE session_id = 'node-session' AND tag_number = 1",
					);
				},
			});
		});
		await ensurePiTagSnapshotReady(h.db, "node-session", new PiContextBudget());
		assert.equal(starts, 4);
		const tags = getPiTagSnapshotView(h.db, "node-session");
		assert.equal(tags.length, 768);
		assert.equal(tags[0]?.tagNumber, 1);
		assert.equal(tags[0]?.byteSize, 13);
		assert.deepEqual(tags, getTagsBySession(h.db, "node-session"));
	} finally {
		await h.close();
	}
});

test("Node worker preserves complete tag projections and rejects a real late drop", async () => {
	const h = fixture();
	const request = {
		path: h.path,
		sessionId: "node-session",
		connectionEpoch: 1,
		sessionEpoch: 1,
		jobId: 1,
	};
	try {
		const good = startPiTagSnapshotWorker(request);
		const { candidate } = await good.result;
		await good.released;
		assert.deepEqual(candidate.tags, getTagsBySession(h.db, "node-session"));
		assert.equal(candidate.active.length, 768);
		assert.equal(candidate.fallback.length, 768);
		const stale = startPiTagSnapshotWorker(request, {
			beforeAck: async (message) => {
				if (message.type === "end" && message.stream === "fallback")
					h.writer.exec(
						"UPDATE tags SET status = 'dropped' WHERE session_id = 'node-session' AND tag_number = 1",
					);
			},
		});
		await assert.rejects(stale.result, /session tags changed after final page/);
		await stale.released;
	} finally {
		await h.close();
	}
});
