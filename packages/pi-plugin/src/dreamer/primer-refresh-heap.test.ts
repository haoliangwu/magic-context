import { afterEach, expect, test } from "bun:test";
import { closeSync, openSync, rmSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	assertBoundedHeap,
	measurePrimerRefresh,
} from "@magic-context/core/features/magic-context/dreamer/__tests__/primer-refresh-heap-fixture.test";
import {
	_resetHarnessForTesting,
	setHarness,
} from "@magic-context/core/shared/harness";
import { createTestTempDirFromPath } from "../../../plugin/src/shared/test-temp-dir";
import { createPiPrimerRawProviderFactory } from "./primer-raw-provider-pi";

const dirs: string[] = [];
afterEach(() => {
	_resetHarnessForTesting();
	for (const dir of dirs.splice(0))
		rmSync(dir, { recursive: true, force: true });
});

function fixture(turns: number): string {
	const dir = createTestTempDirFromPath(join(tmpdir(), "mc-pi-primer-heap-"));
	dirs.push(dir);
	const fd = openSync(join(dir, "session.jsonl"), "w");
	const line = (entry: unknown) => writeSync(fd, `${JSON.stringify(entry)}\n`);
	try {
		line({
			type: "session",
			version: 3,
			id: "ses_primer",
			cwd: "/fixture/primer",
			timestamp: new Date(0).toISOString(),
		});
		const output = "x".repeat(16_384);
		const diagnostics = Array.from({ length: 40 }, (_, i) => ({
			message: `Unresolved reference: symbol${i}`,
			severity: 1,
		}));
		for (let i = 1; i <= turns; i++) {
			const base = {
				type: "message",
				timestamp: new Date(i * 1000).toISOString(),
			};
			line({
				...base,
				id: `u${i}`,
				message: { role: "user", content: `question ${i}` },
			});
			line({
				...base,
				id: `a${i}`,
				message: {
					role: "assistant",
					content: [
						{ type: "text", text: `answer ${i}` },
						{
							type: "toolCall",
							id: `call${i}`,
							name: "read",
							arguments: { filePath: `/src/File${i}.kt` },
						},
					],
				},
			});
			line({
				...base,
				id: `t${i}`,
				message: {
					role: "toolResult",
					toolCallId: `call${i}`,
					toolName: "read",
					content: [{ type: "text", text: output }],
					details: { diagnostics },
				},
			});
		}
	} finally {
		closeSync(fd);
	}
	return dir;
}

test("Pi primer refresh peak heap does not grow with same-project history", async () => {
	setHarness("pi");
	const measurements = [];
	for (const turns of [500, 5_000]) {
		const sessionDir = fixture(turns);
		measurements.push(
			await measurePrimerRefresh(
				"ses_primer",
				turns * 2 + 1,
				createPiPrimerRawProviderFactory({ sessionDir }),
			),
		);
	}
	expect(measurements).toHaveLength(2);
	assertBoundedHeap(measurements[0], measurements[1]);
}, 60_000);
