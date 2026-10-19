// Run from packages/pi-plugin after bundling for Node with Bun's build command.
// Only generated test-owned sessions are opened; no host session discovery runs.
// A "before" run must bundle the synchronous provider and decoder, not the async implementation.
import { closeSync, openSync, rmSync, statSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { readRetrospectiveScanWindow } from "../../plugin/src/features/magic-context/dreamer/retrospective-raw-provider";
import { createTestTempDirFromPath } from "../../plugin/src/shared/test-temp-dir";
import { PiRetrospectiveRawProvider } from "../src/dreamer/retrospective-raw-provider-pi";

const dir = createTestTempDirFromPath(join(tmpdir(), "pi-retro-lag-"));
const sessions = 200;
const mode = process.argv[2] ?? "after";
if (mode !== "before" && mode !== "after")
	throw new Error("Expected before or after");
let bytes = 0;
try {
	const output = "x".repeat(16_384);
	for (let s = 0; s < sessions; s++) {
		const path = join(dir, `${s}.jsonl`);
		const fd = openSync(path, "w");
		try {
			writeSync(
				fd,
				`${JSON.stringify({ type: "session", version: 3, id: `s-${s}`, cwd: "/fixture" })}\n`,
			);
			for (let i = 0; i < 330; i++) {
				writeSync(
					fd,
					`${JSON.stringify({ type: "message", id: `t-${i}`, message: { role: "toolResult", content: output } })}\n`,
				);
				if (i % 100 === 0)
					writeSync(
						fd,
						`${JSON.stringify({ type: "message", id: `u-${i}`, parentId: i ? "fork" : null, message: { role: "user", timestamp: 1000 + s + (330 - i), content: `question ${s}/${i}` } })}\n`,
					);
			}
		} finally {
			closeSync(fd);
		}
		bytes += statSync(path).size;
	}
	console.log(
		JSON.stringify({
			node: process.version,
			sessions,
			bytes,
			probe_interval_ms: 10,
		}),
	);
	{
		const provider = new PiRetrospectiveRawProvider({
			sessionDir: dir,
			projectCwd: "/fixture",
		});
		let previous = performance.now();
		let maxGap = 0;
		let probes = 0;
		const timer = setInterval(() => {
			const now = performance.now();
			maxGap = Math.max(maxGap, now - previous);
			previous = now;
			probes++;
		}, 10);
		await delay(30);
		const start = performance.now();
		const result = await readRetrospectiveScanWindow(provider, "fixture", 0, 3);
		const duration = performance.now() - start;
		await delay(30);
		clearInterval(timer);
		console.log(
			JSON.stringify({
				mode,
				duration_ms: duration,
				max_main_thread_block_ms: Math.max(0, maxGap - 10),
				max_probe_gap_ms: maxGap,
				probes,
				messages: result.messages.length,
			}),
		);
		if (mode === "after" && maxGap - 10 >= 50) process.exitCode = 1;
	}
} finally {
	rmSync(dir, { recursive: true, force: true });
}
