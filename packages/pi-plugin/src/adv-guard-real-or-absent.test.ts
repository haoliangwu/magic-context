/**
 * Adversarial reproduction: the dropped-input guard (OpenCode core and the Pi
 * wrapper) against arguments copied from real-or-absent skeletons, the legacy
 * marker, and real arguments that happen to contain placeholder-shaped text.
 * When ADV_SERVED_JSON names a served request dump from the real-host drive,
 * every tool_use input in it is also run through both guards.
 */
import { describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { createDroppedInputGuard } from "@magic-context/core/hooks/magic-context/dropped-input-guard";
import { createPiDroppedInputGuard } from "./dropped-input-guard-pi";

const core = createDroppedInputGuard();
const pi = createPiDroppedInputGuard();
const verdicts = (toolName: string, input: unknown) => ({
	core:
		core.check({ sessionID: "ses-adv", toolName, input }) === undefined
			? "pass"
			: "REFUSED",
	pi:
		pi({ toolName, input, type: "tool_call", toolCallId: "t" } as never) ===
		undefined
			? "pass"
			: "REFUSED",
});

describe("ADV guard vs real-or-absent", () => {
	it("copied real-argument calls pass; the legacy marker is still refused", () => {
		const cases: Array<[string, string, unknown]> = [
			[
				"kept small bash",
				"bash",
				{ command: "echo small", description: "small" },
			],
			[
				"kept 1024-byte multi-byte bash",
				"bash",
				{ command: `echo ${"\u00e9".repeat(509)}`, description: "d" },
			],
			[
				"request-ending large",
				"bash",
				{ command: `echo ${"E".repeat(3000)}`, description: "end" },
			],
			["legacy marker", "bash", { dropped: "[dropped §3§]" }],
			// Real arguments that contain placeholder-shaped text.
			[
				"real grep for a tag placeholder",
				"bash",
				{ command: 'grep -rn "[dropped §12§]" .' },
			],
			[
				"real echo of a truncation suffix",
				"bash",
				{ command: 'echo "which...[truncated]"' },
			],
		];
		const results = Object.fromEntries(
			cases.map(([label, tool, input]) => [label, verdicts(tool, input)]),
		);
		const served = process.env.ADV_SERVED_JSON;
		const servedResults: Record<string, unknown> = {};
		if (served && existsSync(served)) {
			const messages = JSON.parse(readFileSync(served, "utf8")) as Array<{
				content: unknown;
			}>;
			for (const message of messages) {
				if (!Array.isArray(message.content)) continue;
				for (const block of message.content as Array<Record<string, unknown>>) {
					if (block.type !== "tool_use") continue;
					servedResults[String(block.id)] = verdicts(
						String(block.name),
						block.input,
					);
				}
			}
		}
		console.log(
			"ADV_GUARD",
			JSON.stringify({ results, servedResults }, null, 1),
		);
		expect(results["kept small bash"]).toEqual({ core: "pass", pi: "pass" });
		expect(results["kept 1024-byte multi-byte bash"]).toEqual({
			core: "pass",
			pi: "pass",
		});
		expect(results["request-ending large"]).toEqual({
			core: "pass",
			pi: "pass",
		});
		expect(results["legacy marker"]).toEqual({
			core: "REFUSED",
			pi: "REFUSED",
		});
		for (const verdict of Object.values(servedResults)) {
			expect(verdict).toEqual({ core: "pass", pi: "pass" });
		}
	});
});
