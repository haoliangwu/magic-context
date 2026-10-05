/// <reference types="bun-types" />

import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { insertMemory } from "../../plugin/src/features/magic-context/memory/storage-memory";
import { TestHarness } from "../src/harness";
import { openTestDb } from "../src/test-db";
import {
	assertIsolatedStores,
	countBanked,
	dreamerConfig,
	isVerifyRequest,
	projectIdentity,
	readDreamerInvocations,
	seedMappedMemories,
	startDream,
} from "./dreamer-timeout-support";

const FINALIZE = "You're out of token budget";
const REFUSED = "Out of token budget: no more tool calls";
const BUDGET = 1_400_000;
const usage = (input = 20_000, cache = 100_000) => ({
	input_tokens: input,
	cache_read_input_tokens: cache,
	cache_creation_input_tokens: 0,
	output_tokens: 80,
});

// Real host probes are opt-in because the ordinary suite also supports OpenCode 2.
for (const mode of [
	"refusals",
	"completed",
	"coarse",
	"normal",
	"map",
] as const) {
	test.skipIf(process.env.MC_E2E_OC1_BUDGET_PROBE !== "1")(
		`OpenCode 1.18.30 verify budget: ${mode}`,
		async () => {
			expect(
				spawnSync("opencode", ["--version"], {
					encoding: "utf8",
				}).stdout.trim(),
			).toBe("1.18.30");
			const previousEntry = process.env.MC_E2E_PLUGIN_ENTRY;
			const previousLog = process.env.MAGIC_CONTEXT_LOG_PATH;
			const logPath = join(
				tmpdir(),
				`verify-budget-${mode}-${crypto.randomUUID()}.log`,
			);
			process.env.MAGIC_CONTEXT_LOG_PATH = logPath;
			process.env.MC_E2E_PLUGIN_ENTRY = resolve(
				import.meta.dir,
				"../../plugin/src/index.ts",
			);
			const task =
				mode === "map"
					? "map-memories"
					: mode === "normal"
						? "verify"
						: "verify-broad";
			const normal = mode === "normal" || mode === "map";
			const config = dreamerConfig("verify-broad", 5);
			(config.tasks as Record<string, unknown>)["verify-broad"] = {
				schedule: "",
			};
			(config.tasks as Record<string, unknown>)[task] = {
				schedule: "0 3 * * *",
				...(normal ? {} : { token_budget: BUDGET }),
			};
			let h: TestHarness | undefined;
			try {
				h = await TestHarness.create({
					magicContextConfig: {
						embedding: { provider: "off" },
						dreamer: config,
					},
				});
				assertIsolatedStores(h);
				const parent = await h.createSession();
				h.mock.setDefault({ text: "ack", usage: usage(1, 0) });
				await h.sendPrompt(parent, "bootstrap isolated verify token probe");
				const identity = projectIdentity(h);
				let ids: number[];
				if (mode === "map") {
					const db = openTestDb(
						join(h.dataDir, "cortexkit", "magic-context", "context.db"),
					);
					try {
						ids = Array.from(
							{ length: 20 },
							(_, index) =>
								insertMemory(db as never, {
									projectPath: identity,
									category: "ARCHITECTURE",
									content: `Independent mock mapping ${index}.`,
								}).id,
						);
					} finally {
						db.close();
					}
				} else
					ids = seedMappedMemories(h, identity, mode === "normal" ? 20 : 1);
				let steps = 0;
				let finalizeRequests = 0;
				let refusalRequests = 0;
				h.mock.addMatcher((body) => {
					if (
						mode === "map"
							? !JSON.stringify(body).includes("Output ONE XML manifest")
							: !isVerifyRequest(body)
					)
						return null;
					const payload = JSON.stringify(body);
					const finalize = payload.includes(FINALIZE);
					if (finalize) finalizeRequests++;
					if (payload.includes(REFUSED)) refusalRequests++;
					if (normal && steps >= 15) {
						return {
							text:
								mode === "map"
									? `<mappings>${ids.map((id) => `<memory id="${id}" independent="true"/>`).join("")}</mappings>`
									: `<verify>${ids.map((id) => `<verified id="${id}"/>`).join("")}</verify>`,
							usage: usage(10_000, 100_000),
						};
					}
					if (finalize && mode === "completed") {
						return {
							text: `<verify><verified id="${ids[0]}"/></verify>`,
							usage: usage(120_000, 120_000),
						};
					}
					// Hold the next generation open so the polling transport can
					// observe the preceding persisted usage before it completes.
					if (finalize && refusalRequests >= 2) {
						return { text: "waiting", usage: usage(1, 60_000), delayMs: 3_000 };
					}
					steps++;
					return {
						content: [
							{
								type: "tool_use" as const,
								id: `toolu_verify_${steps}`,
								name: "read",
								input: { filePath: "fact.txt" },
							},
						],
						stop_reason: "tool_use" as const,
						usage: normal
							? usage(10_000, 100_000)
							: finalize
								? usage(1, 60_000)
								: mode === "coarse" && steps === 10
									? usage(210_000, 120_000)
									: usage(),
						delayMs: 1_200,
					};
				});
				const dream = startDream(h, parent, task);
				const activeHarness = h;
				await h.waitFor(
					() =>
						readDreamerInvocations(activeHarness, parent).some(
							(row) => row.ended_at !== null,
						),
					{
						timeoutMs: 90_000,
						intervalMs: 500,
						label: `${mode} invocation ended`,
					},
				);
				await dream;
				const rows = readDreamerInvocations(h, parent);
				const banked = countBanked(h, ids);
				console.log(
					`[verify-budget-${mode}] ${JSON.stringify({ steps, finalizeRequests, refusalRequests, banked, rows })}`,
				);
				assertIsolatedStores(h);
				const log = readFileSync(logPath, "utf8");
				if (mode === "completed" || mode === "refusals")
					expect(log).toContain("dreamer token budget: finalize fired");
				if (mode === "refusals")
					expect(
						log.match(/dreamer token budget: tool call refused/g),
					).toHaveLength(2);
				console.log(
					`[verify-budget-log-${mode}] ${log
						.split("\n")
						.filter((line) => line.includes("dreamer token budget:"))
						.join("\n")}`,
				);
				if (normal) {
					expect(finalizeRequests).toBe(0);
					expect(rows).toHaveLength(1);
					expect(rows[0]?.status).toBe("completed");
					if (mode === "normal") expect(banked).toBe(20);
					else {
						const db = openTestDb(
							join(h.dataDir, "cortexkit", "magic-context", "context.db"),
							{ readonly: true },
						);
						try {
							expect(
								(
									db
										.prepare("SELECT COUNT(*) AS n FROM memory_verifications")
										.get() as { n: number }
								).n,
							).toBe(20);
						} finally {
							db.close();
						}
					}
				} else if (mode === "completed") {
					expect(finalizeRequests).toBeGreaterThan(0);
					expect(rows[0]?.status).toBe("completed");
					expect(banked).toBe(1);
				} else {
					expect(rows[0]?.error).toContain("token_budget");
					expect(banked).toBe(0);
					if (mode === "refusals") {
						expect(finalizeRequests).toBeGreaterThan(0);
						expect(refusalRequests).toBeGreaterThanOrEqual(2);
					} else {
						expect(finalizeRequests).toBe(0);
					}
				}
			} finally {
				await h?.dispose();
				if (previousEntry === undefined) delete process.env.MC_E2E_PLUGIN_ENTRY;
				else process.env.MC_E2E_PLUGIN_ENTRY = previousEntry;
				if (previousLog === undefined)
					delete process.env.MAGIC_CONTEXT_LOG_PATH;
				else process.env.MAGIC_CONTEXT_LOG_PATH = previousLog;
				rmSync(logPath, { force: true });
			}
		},
		120_000,
	);
}
