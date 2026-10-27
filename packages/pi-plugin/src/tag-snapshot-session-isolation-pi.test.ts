import { expect, it } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runMigrations } from "@magic-context/core/features/magic-context/migrations";
import { initializeDatabase } from "@magic-context/core/features/magic-context/storage-db";
import { Database } from "@magic-context/core/shared/sqlite";
import { createTestTempDirFromPath } from "../../plugin/src/shared/test-temp-dir";
import { PiContextBudget } from "./pi-context-budget";
import {
	__setPiTagSnapshotWorkerForTests,
	cancelPiTagSnapshotSession,
	drainPiTagSnapshotSession,
	ensurePiTagSnapshotReady,
	getPiTagSnapshotView,
} from "./tag-snapshot-pi";
import {
	PiTagHydrationError,
	startPiTagSnapshotWorker,
} from "./tag-snapshot-worker-client-pi";

it("a deadline-terminated session cannot refuse another session's hydration", async () => {
	const root = createTestTempDirFromPath(
		join(tmpdir(), "pi-hydration-isolation-"),
	);
	const path = join(root, "context.db");
	const db = new Database(path);
	const sessions = ["deadline-slow", "deadline-small", "deadline-third"];
	try {
		initializeDatabase(db);
		runMigrations(db);
		const insert = db.prepare(`INSERT INTO tags
			(session_id, tag_number, message_id, type, status, byte_size)
			VALUES (?, ?, ?, 'message', 'active', 100)`);
		db.transaction(() => {
			for (let n = 1; n <= 4096; n++) insert.run(sessions[0], n, `entry-${n}`);
			for (const session of sessions.slice(1))
				insert.run(session, 1, "entry-1");
		})();
		const constructed: string[] = [];
		let packets = 0;
		__setPiTagSnapshotWorkerForTests(db, (request, cached) => {
			constructed.push(request.sessionId);
			const slow = request.sessionId === sessions[0];
			return startPiTagSnapshotWorker(
				{ ...request, test: slow ? { pageDelayMs: 50 } : undefined },
				{
					cached,
					deadlineMs: slow ? 600 : 5000,
					beforeAck: async (message) => {
						if (slow && message.type === "packet") packets++;
					},
				},
			);
		});
		let failure: unknown;
		try {
			await ensurePiTagSnapshotReady(db, sessions[0], new PiContextBudget());
		} catch (error) {
			failure = error;
		}
		expect(failure).toBeInstanceOf(PiTagHydrationError);
		expect(failure).toMatchObject({ code: "deadline" });
		expect(packets).toBeGreaterThan(0);
		await drainPiTagSnapshotSession(sessions[0]);
		// The failed session still backs off; another session must not inherit it.
		await expect(
			ensurePiTagSnapshotReady(db, sessions[0], new PiContextBudget()),
		).rejects.toBe(failure);
		expect(constructed).toEqual([sessions[0]]);
		cancelPiTagSnapshotSession(sessions[0]);
		for (const session of sessions.slice(1)) {
			let nextFailure: unknown;
			try {
				await ensurePiTagSnapshotReady(db, session, new PiContextBudget());
			} catch (error) {
				nextFailure = error;
			}
			expect(constructed).toContain(session);
			expect(nextFailure).toBeUndefined();
			expect(getPiTagSnapshotView(db, session)).toHaveLength(1);
			cancelPiTagSnapshotSession(session);
			await drainPiTagSnapshotSession(session);
		}
		expect(constructed).toEqual(sessions);
	} finally {
		for (const session of sessions) cancelPiTagSnapshotSession(session);
		await Promise.all(sessions.map(drainPiTagSnapshotSession));
		db.close();
		rmSync(root, { recursive: true, force: true });
	}
});
