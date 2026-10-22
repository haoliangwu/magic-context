/**
 * Measure main-thread heartbeat gaps through readiness and owner publication:
 * ten fresh connections, complete borrowed snapshot, then one event-loop turn.
 * Preserve this allocation/scheduling pattern for comparable repeated runs.
 * Seeded SQLite pages are OS-cache warm. This does not simulate cold disk.
 *
 * Bun: bun packages/pi-plugin/scripts/experiments/perf/tag-hydration.ts
 * Node: bundle this and tag-snapshot-worker-pi.ts beside each other in a
 * separate scratch directory, then run tag-hydration.js with Node.
 * Set BUN_JSC_logGC=1 or use node --trace-gc in a separate attribution run.
 *
 * --memory-diagnostic --heap-snapshot PATH is a separate memory-only mode.
 * It retains the first loaded array as a positive control, writes PATH.retained,
 * releases that reference, then writes PATH after collection. Validate both
 * with hydration-heap-assay.ts; do not substitute these timings for latency runs.
 */

import { spawn } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import { loadavg, tmpdir } from "node:os";
import { join } from "node:path";
import { runMigrations } from "../../../../plugin/src/features/magic-context/migrations";
import { initializeDatabase } from "../../../../plugin/src/features/magic-context/storage-db";
import { Database } from "../../../../plugin/src/shared/sqlite";
import { createTestTempDirFromPath } from "../../../../plugin/src/shared/test-temp-dir";
import { PiContextBudget } from "../../../src/pi-context-budget";
import {
	__setPiTagSnapshotWorkerForTests,
	ensurePiTagSnapshotReady,
	getPiTagSnapshotView,
} from "../../../src/tag-snapshot-pi";
import { startPiTagSnapshotWorker } from "../../../src/tag-snapshot-worker-client-pi";

const samples = process.argv.includes("--realistic") ? 1 : 10;
const realistic = process.argv.includes("--realistic");
const memoryDiagnostic = process.argv.includes("--memory-diagnostic");
if (memoryDiagnostic && !process.argv.includes("--heap-snapshot"))
	throw new Error("--memory-diagnostic requires --heap-snapshot");
const gapLimitMs = process.versions.bun ? 50 : 60;
const count = 200_000;
const capacity = 20_000;
// Telemetry is allocated before measurement; the heartbeat only writes numbers.
const ticks = new Float64Array(samples * capacity);
const results = new Float64Array(samples * 10);
const machineLoads = new Float64Array(4000);
let machineLoadCount = 0;
const root = createTestTempDirFromPath(join(tmpdir(), "pi-tag-cold-gate-"));
const path = join(root, "context.db");
const retentionRoot = globalThis as typeof globalThis & {
	__piLoadedRowControl?: unknown;
};
// A separate diagnostic scope bounds the caller's borrowed view independently
// of cache ownership. Normal runs never retain the positive-control array.
async function borrowForMemory(
	connection: InstanceType<typeof Database>,
	retain: boolean,
) {
	const rows = getPiTagSnapshotView(connection, "s");
	if (retain) retentionRoot.__piLoadedRowControl = rows;
	await new Promise<void>((resolve) => setImmediate(resolve));
	if (rows.length !== count) throw new Error("incomplete diagnostic snapshot");
}
const seed = new Database(path);
initializeDatabase(seed);
runMigrations(seed);
const insert = seed.prepare(
	"INSERT INTO tags(session_id, tag_number, message_id, type, status, byte_size, tool_name, tool_owner_message_id, entry_fingerprint) VALUES('s', ?, ?, ?, ?, ?, ?, ?, ?)",
);
seed.transaction(() => {
	for (let n = 1; n <= count; n++) {
		const tool = realistic && n % 2 === 0;
		const fallback = realistic && n % 100 === 0;
		insert.run(
			n,
			fallback ? `pi-msg-${n}` : `entry-${n}:p0`,
			tool ? "tool" : "message",
			n % 7 === 0 ? "dropped" : "active",
			realistic ? 128 + (n % 8192) : 100,
			tool ? "read_file" : null,
			tool ? `entry-${n - 1}:p0` : null,
			fallback ? `fingerprint-${n.toString(16).padStart(48, "0")}` : null,
		);
	}
})();
seed.close();
console.log(
	JSON.stringify({
		event: "seeded",
		count,
		realistic,
		runtime: process.versions,
		wallMs: Date.now(),
		monotonicMs: performance.now(),
	}),
);
let control: ReturnType<typeof spawn> | undefined;
let controlOutput = "";
let machineTimer: ReturnType<typeof setInterval> | undefined;
if (process.argv.includes("--control")) {
	const env = { ...process.env };
	delete env.BUN_JSC_logGC;
	control = spawn(
		process.execPath,
		[
			"-e",
			`
		const ticks = new Float64Array(40000); let count = 0;
		const timer = setInterval(() => { if (count >= ticks.length) throw new Error("control overflow"); ticks[count++] = performance.timeOrigin + performance.now(); }, 5);
		process.stdin.resume(); process.stdin.once("end", () => { clearInterval(timer); console.log(JSON.stringify({event:"idle-control",ticks:Array.from(ticks.subarray(0,count))})); });
		console.log("CONTROL_READY");
	`,
		],
		{ env, stdio: ["pipe", "pipe", "inherit"] },
	);
	await new Promise<void>((resolve, reject) => {
		control!.once("error", reject);
		control!.stdout!.on("data", (data) => {
			controlOutput += data.toString();
			if (controlOutput.includes("CONTROL_READY")) resolve();
		});
	});
	machineTimer = setInterval(() => {
		const offset = machineLoadCount++ * 4;
		if (offset + 4 > machineLoads.length)
			throw new Error("load telemetry overflow");
		machineLoads[offset] = Date.now();
		machineLoads.set(loadavg(), offset + 1);
	}, 1000);
}
try {
	for (let sample = 0; sample < samples; sample++) {
		const connection = new Database(path);
		initializeDatabase(connection);
		if (process.argv.includes("--telemetry")) {
			__setPiTagSnapshotWorkerForTests(connection, (request, cached) => {
				const job = startPiTagSnapshotWorker(request, { cached });
				return {
					...job,
					result: job.result.then((result) => {
						console.log(
							"WORKER_TELEMETRY",
							JSON.stringify({
								...result.telemetry,
								estimatedBytes: result.candidate.estimatedBytes,
							}),
						);
						return result;
					}),
				};
			});
		}
		let tickCount = 0;
		const base = sample * capacity;
		const started = performance.now();
		console.log(`LOAD_START ${sample} ${Date.now()} ${started}`);
		const heartbeat = setInterval(() => {
			if (tickCount < capacity) ticks[base + tickCount++] = performance.now();
		}, 5);
		try {
			const pending = ensurePiTagSnapshotReady(
				connection,
				"s",
				new PiContextBudget(),
			);
			if (!pending) throw new Error("cold gate unexpectedly hit a ready cache");
			await pending;
			if (memoryDiagnostic) await borrowForMemory(connection, sample === 0);
			else {
				const rows = getPiTagSnapshotView(connection, "s");
				await new Promise<void>((resolve) => setImmediate(resolve));
				if (rows.length !== count) throw new Error("incomplete snapshot");
			}
			if (tickCount === capacity)
				throw new Error("heartbeat telemetry overflow");
			const memory = process.memoryUsage();
			const offset = sample * 10;
			results[offset] = started;
			results[offset + 1] = performance.now();
			results[offset + 2] = tickCount;
			results[offset + 3] = memory.rss;
			results[offset + 4] = process.resourceUsage().maxRSS;
			results[offset + 5] = memory.heapUsed;
			results[offset + 6] = memory.external;
			results[offset + 7] = memory.arrayBuffers;
			console.log(`LOAD_END ${sample} ${Date.now()} ${results[offset + 1]}`);
		} finally {
			clearInterval(heartbeat);
			connection.close();
		}
	}
	if (control) {
		clearInterval(machineTimer);
		const exit = new Promise<void>((resolve, reject) => {
			control!.once("exit", (code) =>
				code === 0 ? resolve() : reject(new Error(`control exited ${code}`)),
			);
		});
		control.stdin!.end();
		await exit;
		console.log(controlOutput.trim());
		console.log(
			JSON.stringify({
				event: "machine-load",
				samples: Array.from(machineLoads.subarray(0, machineLoadCount * 4)),
			}),
		);
	}
	let pass = true;
	const maxima: number[] = [];
	for (let sample = 0; sample < samples; sample++) {
		const offset = sample * 10;
		let last = results[offset];
		const gaps = [];
		for (let i = 0; i < results[offset + 2]; i++) {
			const now = ticks[sample * capacity + i];
			gaps.push({ start: last, end: now, ms: now - last });
			last = now;
		}
		// Include the final turn even when its timer is not due before the
		// immediate resolves; otherwise a blocking publication could be missed.
		gaps.push({
			start: last,
			end: results[offset + 1],
			ms: results[offset + 1] - last,
		});
		const maxGapMs = Math.max(...gaps.map((gap) => gap.ms));
		maxima.push(maxGapMs);
		pass &&= maxGapMs <= gapLimitMs;
		console.log(
			JSON.stringify({
				sample,
				startWallMs: performance.timeOrigin + results[offset],
				endWallMs: performance.timeOrigin + results[offset + 1],
				tags: count,
				maxGapMs,
				jobMs: results[offset + 1] - results[offset],
				rssBytes: results[offset + 3],
				peakRssKiB: results[offset + 4],
				heapUsed: results[offset + 5],
				external: results[offset + 6],
				arrayBuffers: results[offset + 7],
				gaps,
			}),
		);
	}
	maxima.sort((a, b) => a - b);
	console.log(
		JSON.stringify({
			event: "gate",
			samples,
			gapLimitMs,
			p50MaxGapMs: maxima[Math.ceil(samples * 0.5) - 1],
			p95MaxGapMs: maxima[Math.ceil(samples * 0.95) - 1],
			maxGapMs: maxima.at(-1),
			pass,
		}),
	);
	if (!pass) process.exitCode = 1;
	const snapshotIndex = process.argv.indexOf("--heap-snapshot");
	if (snapshotIndex !== -1) {
		const snapshotPath = process.argv[snapshotIndex + 1];
		if (!snapshotPath) throw new Error("--heap-snapshot requires a file path");
		const v8 = process.versions.bun ? undefined : await import("node:v8");
		// Heap profiling can collect. It is deliberately outside every measured
		// load, never part of production, and never a passing latency sample.
		const writeSnapshot = (path: string) => {
			if (process.versions.bun) {
				const snapshot = Bun.generateHeapSnapshot("v8");
				writeFileSync(
					path,
					typeof snapshot === "string" ? snapshot : JSON.stringify(snapshot),
				);
			} else v8!.writeHeapSnapshot(path);
		};
		const captureReleased = () => {
			console.log(
				"DIAGNOSTIC_COLLECTION_BEFORE",
				JSON.stringify(process.memoryUsage()),
			);
			if (process.versions.bun) {
				Bun.gc(true);
				console.log(
					"DIAGNOSTIC_COLLECTION_AFTER",
					JSON.stringify(process.memoryUsage()),
				);
				writeSnapshot(snapshotPath);
			} else {
				writeSnapshot(snapshotPath);
				console.log(
					"DIAGNOSTIC_COLLECTION_AFTER",
					JSON.stringify(process.memoryUsage()),
				);
			}
		};
		process.once("beforeExit", () => {
			if (!memoryDiagnostic) return captureReleased();
			console.log("DIAGNOSTIC_RETAINED_LOADED_ROWS", count);
			writeSnapshot(`${snapshotPath}.retained`);
			delete retentionRoot.__piLoadedRowControl;
			setImmediate(captureReleased);
		});
	}
} finally {
	clearInterval(machineTimer);
	control?.stdin?.end();
	rmSync(root, { recursive: true, force: true });
}
