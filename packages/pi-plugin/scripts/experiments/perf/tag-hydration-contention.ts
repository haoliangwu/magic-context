/**
 * Exercise the complete owner publication path, not just the worker, against
 * a temporary 200,000-tag session while a separate thread commits at 20 Hz.
 * Run: bun packages/pi-plugin/scripts/experiments/perf/tag-hydration-contention.ts
 * Never opens a configured or live store. Output is newline-delimited JSON.
 */
import { once } from "node:events";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isMainThread, parentPort, Worker, workerData } from "node:worker_threads";
import { runMigrations } from "../../../../plugin/src/features/magic-context/migrations";
import { initializeDatabase } from "../../../../plugin/src/features/magic-context/storage-db";
import { Database } from "../../../../plugin/src/shared/sqlite";
import { createTestTempDirFromPath } from "../../../../plugin/src/shared/test-temp-dir";
import { PiContextBudget } from "../../../src/pi-context-budget";
import {
	__setPiTagSnapshotWorkerForTests,
	drainPiTagSnapshotSession,
	ensurePiTagSnapshotReady,
	getPiTagSnapshotView,
} from "../../../src/tag-snapshot-pi";
import { startPiTagSnapshotWorker } from "../../../src/tag-snapshot-worker-client-pi";

if (!isMainThread) {
	const { path, counter } = workerData as {
		path: string;
		counter: SharedArrayBuffer;
	};
	const commits = new Int32Array(counter);
	const writer = new Database(path);
	initializeDatabase(writer);
	const update = writer.prepare(
		"UPDATE tags SET byte_size = byte_size + 1 WHERE session_id = 'other'",
	);
	const timer = setInterval(() => {
		update.run();
		Atomics.add(commits, 0, 1);
	}, 50);
	parentPort!.once("message", () => {
		clearInterval(timer);
		writer.close();
		parentPort!.close();
	});
	parentPort!.postMessage("ready");
} else {
	const root = createTestTempDirFromPath(join(tmpdir(), "pi-hydration-contention-"));
	const path = join(root, "context.db");
	const seed = new Database(path);
	initializeDatabase(seed);
	runMigrations(seed);
	const insert = seed.prepare(`INSERT INTO tags
		(session_id, tag_number, message_id, type, status, byte_size,
		tool_name, tool_owner_message_id, entry_fingerprint)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
	seed.transaction(() => {
		for (let n = 1; n <= 200_000; n++) {
			const tool = n % 2 === 0;
			insert.run(
				"s", n, n % 100 === 0 ? `pi-msg-${n}` : `entry-${n}:p0`,
				tool ? "tool" : "message", n % 7 === 0 ? "dropped" : "active",
				128 + n % 8192, tool ? "read_file" : null,
				tool ? `entry-${n - 1}:p0` : null,
				n % 100 === 0 ? `fingerprint-${n.toString(16).padStart(48, "0")}` : null,
			);
		}
		insert.run("other", 1, "other-1", "message", "active", 10, null, null, null);
	})();
	seed.close();
	const counter = new SharedArrayBuffer(4);
	const commits = new Int32Array(counter);
	const writer = new Worker(new URL(import.meta.url), { workerData: { path, counter } });
	const writerExit = once(writer, "exit");
	const timings: number[] = [];
	const mainThreadGaps: number[] = [];
	let success = 0;
	let started = 0;
	try {
		await once(writer, "message");
		started = performance.now();
		for (let run = 1; run <= 20; run++) {
			const connection = new Database(path);
			initializeDatabase(connection);
			const before = Atomics.load(commits, 0);
			const start = performance.now();
			let lastTick = start;
			let maxMainThreadGapMs = 0;
			const heartbeat = setInterval(() => {
				const now = performance.now();
				maxMainThreadGapMs = Math.max(maxMainThreadGapMs, now - lastTick);
				lastTick = now;
			}, 5);
			let telemetry: unknown;
			__setPiTagSnapshotWorkerForTests(connection, (request, cached) => {
				const job = startPiTagSnapshotWorker(request, { cached });
				return { ...job, result: job.result.then((result) => {
					telemetry = result.telemetry;
					return result;
				}) };
			});
			try {
				await ensurePiTagSnapshotReady(connection, "s", new PiContextBudget());
				const tags = getPiTagSnapshotView(connection, "s");
				if (tags.length !== 200_000 || tags[0]?.tagNumber !== 1 || tags.at(-1)?.tagNumber !== 200_000)
					throw new Error("incomplete published snapshot");
				success++;
				const ms = performance.now() - start;
				maxMainThreadGapMs = Math.max(maxMainThreadGapMs, performance.now() - lastTick);
				timings.push(ms);
				mainThreadGaps.push(maxMainThreadGapMs);
				console.log(JSON.stringify({ run, ok: true, ms, maxMainThreadGapMs, commits: Atomics.load(commits, 0) - before, telemetry }));
			} catch (error) {
				console.log(JSON.stringify({ run, ok: false, ms: performance.now() - start, error: String(error) }));
			} finally {
				clearInterval(heartbeat);
				await drainPiTagSnapshotSession("s");
				connection.close();
			}
		}
		const elapsed = performance.now() - started;
		console.log(JSON.stringify({
			event: "summary", runtime: process.versions, tags: 200_000, runs: 20, success,
			elapsedMs: elapsed, commits: Atomics.load(commits, 0),
			commitsPerSecond: Atomics.load(commits, 0) / (elapsed / 1000),
			minMs: Math.min(...timings), maxMs: Math.max(...timings),
			meanMs: timings.reduce((sum, ms) => sum + ms, 0) / timings.length,
			maxMainThreadGapMs: Math.max(...mainThreadGaps),
		}));
		if (success !== 20) process.exitCode = 1;
	} finally {
		writer.postMessage("stop");
		await writerExit;
		rmSync(root, { recursive: true, force: true });
	}
}
