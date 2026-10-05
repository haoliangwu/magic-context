/**
 * Adversarial reproduction: SIGKILL a Pi child process after the HARD fold has
 * committed but before the pass decides whether the fold opens the mutation
 * lanes (the kill replaces foldBustsServedPrefix, the first thing the pass
 * evaluates after the commit). The parent then reopens the same file-backed
 * database and reports what the next passes serve and whether the queued drop
 * lands, is lost, or stays queued.
 *
 * ADV_PI_LANE_CHILD=<trigger>:<kill|control> runs the child side.
 */
import { describe, expect, it, mock } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestTempDirFromPath } from "../../plugin/src/shared/test-temp-dir";

const CHILD = process.env.ADV_PI_LANE_CHILD;
const DB_PATH = process.env.ADV_PI_LANE_DB;
const OUT = process.env.ADV_PI_LANE_OUT;
const SESSION = "ses-adv-pi-lane-sigkill";
const BASE_MODEL = "anthropic/opus";
const HARD_MODEL = "anthropic/sonnet";

async function harness(dbPath: string) {
	const utils = await import("./test-utils.test");
	const ch = await import("./context-handler");
	const storage = await import(
		"@magic-context/core/features/magic-context/storage"
	);
	const db = utils.createTestDb(dbPath);
	const ids = ["e-1", "e-2", "e-3", "e-4"];
	const build = () =>
		[
			utils.userMessage("start", 1),
			utils.assistantToolCall("call-1", "bash", { command: "cat big" }, 2),
			{
				...utils.toolResultMessage("call-1", "x".repeat(4000), 3),
				toolName: "bash",
			},
			utils.userMessage("next prompt", 4),
		] as never[];
	const fake = utils.createFakePi();
	ch.registerPiContextHandler(
		fake.pi as never,
		{
			db,
			protectedTags: 0,
			heuristics: {},
			injection: { injectionBudgetTokens: 10_000, muralEnabled: true },
			scheduler: { executeThresholdPercentage: 80 },
		} as never,
	);
	const handler = fake.handlers.get("context") as (
		event: { messages: never[] },
		ctx: never,
	) => Promise<{ messages: never[] }>;
	const pass = async () => {
		const messages = build();
		const out = await handler({ messages }, {
			...utils.fakeContext(SESSION, process.cwd(), ids, messages),
			getContextUsage: () => ({
				tokens: 4_000,
				percent: 4,
				contextWindow: 100_000,
			}),
		} as never);
		return JSON.stringify(out.messages);
	};
	const state = () => ({
		tool: storage
			.getTagsBySession(db, SESSION)
			.filter((t) => t.type === "tool")
			.map((t) => t.status),
		pending: storage.getPendingOps(db, SESSION).length,
	});
	return { db, ch, storage, pass, state };
}

describe("ADV Pi: SIGKILL between the HARD fold commit and the lane decision", () => {
	if (CHILD) {
		it("child", async () => {
			const [trigger, variant] = CHILD.split(":");
			if (variant === "kill") {
				const actual = await import(
					"@magic-context/core/hooks/magic-context/apply-operations"
				);
				const original = actual.foldBustsServedPrefix;
				mock.module(
					"@magic-context/core/hooks/magic-context/apply-operations",
					() => ({
						...actual,
						foldBustsServedPrefix: (
							...args: Parameters<typeof actual.foldBustsServedPrefix>
						) => {
							if (!(globalThis as { __advArm?: boolean }).__advArm) {
								return original(...args);
							}
							writeFileSync(
								`${OUT}.killpoint`,
								"reached lane decision after fold commit\n",
							);
							process.kill(process.pid, "SIGKILL");
							throw new Error("unreachable");
						},
					}),
				);
			}
			const h = await harness(DB_PATH ?? "");
			h.storage.updateSessionMeta(h.db, SESSION, {
				piStableIdScheme: 1,
				systemPromptHash: "sys-v1",
			});
			h.ch.recordPiLiveModel(SESSION, BASE_MODEL);
			await h.pass();
			const tag = h.storage
				.getTagsBySession(h.db, SESSION)
				.find((t) => t.type === "tool");
			if (!tag) throw new Error("no tool tag");
			h.storage.queuePendingOp(h.db, SESSION, tag.tagNumber, "drop", 1);
			h.storage.updateSessionMeta(h.db, SESSION, {
				lastResponseTime: Date.now(),
				cacheTtl: "59m",
				lastContextPercentage: 40,
				lastInputTokens: 4_000,
			});
			const defer = await h.pass();
			writeFileSync(
				`${OUT}.defer`,
				JSON.stringify({ defer, state: h.state() }),
			);
			if (trigger === "model") h.ch.recordPiLiveModel(SESSION, HARD_MODEL);
			else
				h.storage.queueM0Mutation(h.db, {
					sessionId: SESSION,
					mutationType: "compartment_delete",
				});
			(globalThis as { __advArm?: boolean }).__advArm = true;
			const hard = await h.pass();
			writeFileSync(`${OUT}.hard`, JSON.stringify({ hard, state: h.state() }));
		}, 60_000);
		return;
	}

	for (const trigger of ["model", "identical"] as const) {
		for (const variant of ["kill", "control"] as const) {
			it(`parent: ${trigger} HARD, ${variant} child`, async () => {
				const root = createTestTempDirFromPath(
					join(
						process.env.ADV_ROOT ?? tmpdir(),
						`pi-lane-sigkill-${trigger}-${variant}-`,
					),
				);
				mkdirSync(root, { recursive: true });
				const dbPath = join(
					createTestTempDirFromPath(join(root, "db-")),
					"context.db",
				);
				const out = join(root, "out");
				const child = spawnSync(
					process.execPath,
					["test", import.meta.path, "--timeout", "60000"],
					{
						windowsHide: true,
						env: {
							...process.env,
							TMPDIR: root,
							ADV_PI_LANE_CHILD: `${trigger}:${variant}`,
							ADV_PI_LANE_DB: dbPath,
							ADV_PI_LANE_OUT: out,
						},
						encoding: "utf8",
						cwd: join(import.meta.dir, ".."),
					},
				);
				const read = (suffix: string) => {
					try {
						return JSON.parse(readFileSync(`${out}.${suffix}`, "utf8"));
					} catch {
						return null;
					}
				};
				const deferRec = read("defer");
				const hardRec = read("hard");
				let killpoint = "";
				try {
					killpoint = readFileSync(`${out}.killpoint`, "utf8").trim();
				} catch {}
				const h = await harness(dbPath);
				h.ch.recordPiLiveModel(
					SESSION,
					trigger === "model" ? HARD_MODEL : BASE_MODEL,
				);
				const afterRestart = h.state();
				const next1 = await h.pass();
				const afterNext1 = h.state();
				const next2 = await h.pass();
				const summary = {
					trigger,
					variant,
					childSignal: child.signal,
					killpoint,
					deferState: deferRec?.state,
					childHardState: hardRec?.state ?? "never-served",
					afterRestart,
					afterNext1,
					next1EqualsNext2: next1 === next2,
					next1EqualsChildDefer: deferRec ? next1 === deferRec.defer : null,
					next1EqualsChildHard: hardRec ? next1 === hardRec.hard : null,
					next1HeadEqualsDeferHead: deferRec
						? JSON.stringify(JSON.parse(next1).slice(0, 2)) ===
							JSON.stringify(JSON.parse(deferRec.defer).slice(0, 2))
						: null,
				};
				console.log("ADV_PI_LANE_SIGKILL", JSON.stringify(summary));
				writeFileSync(
					join(root, "summary.json"),
					JSON.stringify(summary, null, 2),
				);
				h.ch.clearContextHandlerSession(SESSION);
				if (variant === "kill") {
					expect(child.signal).toBe("SIGKILL");
					expect(killpoint).toContain("reached lane decision");
				}
				expect(next1).toBe(next2);
			}, 120_000);
		}
	}
});
