// Lifecycle tests against a real child process. The mock child in
// subagent-runner.test.ts cannot reproduce pipe ownership: a real `close`
// event waits until every process holding the child's stdout/stderr has let
// go, and only a real process tree shows that. The fake Pi here is a shell
// script that prints the same JSON event stream Pi print mode writes.
import { afterEach, describe, expect, it } from "bun:test";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SubagentRunOptions } from "@magic-context/core/shared/subagent-runner";
import { createTestTempDirFromPath } from "../../plugin/src/shared/test-temp-dir";
import { PiSubagentRunner } from "./subagent-runner";

const isWindows = process.platform === "win32";

const tempDirs: string[] = [];
const grandchildPidFiles: string[] = [];

afterEach(() => {
	for (const pidFile of grandchildPidFiles.splice(0)) {
		try {
			const pid = Number(readFileSync(pidFile, "utf8").trim());
			if (Number.isInteger(pid) && pid > 0) process.kill(pid, "SIGKILL");
		} catch {
			// already gone
		}
	}
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

/** `body` receives the script's private temp dir and returns the sh script body. */
function fakePi(body: (dir: string) => string): PiSubagentRunner {
	const dir = createTestTempDirFromPath(join(tmpdir(), "mc-pi-real-child-"));
	tempDirs.push(dir);
	const script = join(dir, "fake-pi.sh");
	writeFileSync(script, `#!/bin/sh\n${body(dir)}\n`, { mode: 0o755 });
	const runner = new PiSubagentRunner({
		invocation: {
			command: "/bin/sh",
			prefixArgs: [script],
			targetHarness: "pi",
		},
	});
	return runner;
}

function jsonLine(event: unknown): string {
	// Single-quoted for sh; the events below never contain a single quote.
	return `printf '%s\\n' '${JSON.stringify(event)}'`;
}

const options: SubagentRunOptions = {
	agent: "historian",
	systemPrompt: "system guidance",
	userMessage: "summarize this session",
	timeoutMs: 60_000,
};

async function within<T>(promise: Promise<T>, ms: number): Promise<T | "HUNG"> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const hung = new Promise<"HUNG">((resolve) => {
		timer = setTimeout(() => resolve("HUNG"), ms);
	});
	try {
		return await Promise.race([promise, hung]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

describe.skipIf(isWindows)("PiSubagentRunner with a real child process", () => {
	it("settles after the final answer even when a grandchild still holds the pipes", async () => {
		// A user extension or MCP stdio server started by Pi inherits Pi's
		// stdout/stderr. It outlives Pi, so the pipes never reach EOF.
		const runner = fakePi((dir) => {
			const pidFile = join(dir, "grandchild.pid");
			grandchildPidFiles.push(pidFile);
			return [
				`sleep 30 & echo $! > '${pidFile}'`,
				jsonLine({
					type: "message_end",
					message: {
						role: "assistant",
						content: [{ type: "text", text: "final answer" }],
						stopReason: "stop",
					},
				}),
				// Pi print mode sometimes idles after the final turn; the
				// runner's drain timer is what ends it.
				"exec sleep 100",
			].join("\n");
		});

		const result = await within(runner.run(options), 12_000);

		expect(result).not.toBe("HUNG");
		expect(result).toMatchObject({ ok: true, assistantText: "final answer" });
	}, 20_000);

	it("lets Pi's own auto-retry land instead of killing it with the drain", async () => {
		const failed = {
			role: "assistant",
			content: [],
			stopReason: "error",
			errorMessage: '529 {"type":"overloaded_error"}',
		};
		const answered = {
			role: "assistant",
			content: [{ type: "text", text: "answer after retry" }],
			stopReason: "stop",
		};
		// Event order of Pi 0.83-0.87 print mode for one transient error
		// (agent-session.js: agent_end carries willRetry, then _prepareRetry
		// emits auto_retry_start and sleeps retry.baseDelayMs = 2000 ms before
		// the next attempt; auto_retry_end follows the successful message_end).
		// The extra half second stands in for the retried request's latency.
		const runner = fakePi(() =>
			[
				jsonLine({ type: "message_end", message: failed }),
				jsonLine({ type: "agent_end", messages: [failed], willRetry: true }),
				jsonLine({
					type: "auto_retry_start",
					attempt: 1,
					maxAttempts: 3,
					delayMs: 2000,
					errorMessage: failed.errorMessage,
				}),
				"sleep 2.5",
				jsonLine({ type: "message_start", message: { role: "assistant" } }),
				jsonLine({ type: "message_end", message: answered }),
				jsonLine({ type: "auto_retry_end", success: true, attempt: 1 }),
				jsonLine({
					type: "agent_end",
					messages: [failed, answered],
					willRetry: false,
				}),
				"exit 0",
			].join("\n"),
		);

		const result = await within(runner.run(options), 15_000);

		expect(result).toMatchObject({
			ok: true,
			assistantText: "answer after retry",
		});
	}, 20_000);

	it("still bounds a retry by the run's hard timeout", async () => {
		const failed = {
			role: "assistant",
			content: [],
			stopReason: "error",
			errorMessage: "503 unavailable",
		};
		const runner = fakePi(() =>
			[
				jsonLine({ type: "message_end", message: failed }),
				jsonLine({ type: "agent_end", messages: [failed], willRetry: true }),
				jsonLine({
					type: "auto_retry_start",
					attempt: 1,
					maxAttempts: 3,
					delayMs: 2000,
					errorMessage: failed.errorMessage,
				}),
				"exec sleep 100",
			].join("\n"),
		);

		const started = Date.now();
		const result = await within(
			runner.run({ ...options, timeoutMs: 3_000 }),
			12_000,
		);

		expect(result).toMatchObject({ ok: false, reason: "timeout" });
		expect(Date.now() - started).toBeLessThan(8_000);
	}, 20_000);
});
