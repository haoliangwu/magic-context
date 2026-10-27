import { expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createSqliteTurnDatabase,
	Database,
} from "@magic-context/core/shared/sqlite";
import { createTestTempDirFromPath } from "../../plugin/src/shared/test-temp-dir";
import {
	inPiHistorianRootContext,
	waitForPiHistorianInTurn,
} from "./pi-historian-turn-wait";

async function underLock(run: (read: () => unknown) => Promise<void>) {
	const dir = createTestTempDirFromPath(join(tmpdir(), "pi-historian-native-"));
	const path = join(dir, "context.db");
	const db = createSqliteTurnDatabase(path);
	db.exec(
		"PRAGMA journal_mode=DELETE; PRAGMA busy_timeout=900; CREATE TABLE t(value); INSERT INTO t VALUES(1)",
	);
	const read = db.prepare("SELECT * FROM t");
	const locker = new Database(path);
	locker.exec("BEGIN EXCLUSIVE");
	try {
		await run(() => read.get());
	} finally {
		locker.exec("ROLLBACK");
		locker.close();
		db.close();
		rmSync(dir, { recursive: true, force: true });
	}
}

test("an awaited root historian shares the waiting turn's native deadline", async () => {
	await underLock(async (read) => {
		const gate = Promise.withResolvers<void>();
		const pending = inPiHistorianRootContext("waiting", async () => {
			await gate.promise;
			return read();
		});
		const start = performance.now();
		await expect(
			waitForPiHistorianInTurn(
				"waiting",
				() => Math.max(0, 80 - (performance.now() - start)),
				() => {
					gate.resolve();
					return pending;
				},
			),
		).rejects.toThrow(/locked|busy/i);
		expect(performance.now() - start).toBeLessThan(400);
	});
});

test("historian native waits keep background timeouts after a turn stops waiting", async () => {
	await underLock(async (read) => {
		await expect(
			waitForPiHistorianInTurn(
				"background",
				() => 0,
				() => Promise.reject(new Error("turn ended")),
			),
		).rejects.toThrow("turn ended");
		const start = performance.now();
		expect(() => inPiHistorianRootContext("background", read)).toThrow(
			/locked|busy/i,
		);
		expect(performance.now() - start).toBeGreaterThan(700);
	});
});

test("an older historian waiter cannot remove a newer turn's allowance", async () => {
	await underLock(async (read) => {
		const older = Promise.withResolvers<void>();
		const newer = Promise.withResolvers<void>();
		const oldWait = waitForPiHistorianInTurn(
			"overlap",
			() => 900,
			() => older.promise,
		);
		const newWait = waitForPiHistorianInTurn(
			"overlap",
			() => 80,
			() => newer.promise,
		);
		try {
			older.resolve();
			await oldWait;
			const start = performance.now();
			expect(() => inPiHistorianRootContext("overlap", read)).toThrow(
				/locked|busy/i,
			);
			expect(performance.now() - start).toBeLessThan(400);
		} finally {
			newer.resolve();
			await newWait;
		}
	});
});
