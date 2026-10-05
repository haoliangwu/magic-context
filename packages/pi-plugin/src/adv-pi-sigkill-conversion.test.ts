/**
 * Adversarial reproduction: Pi converts legacy `{"dropped": …}` skeletons in its
 * own transaction AFTER the HARD fold commits. This test SIGKILLs a child
 * process exactly between the two (the conversion function is replaced by a
 * real `process.kill(process.pid, "SIGKILL")`), then runs the next passes in
 * this (parent) process against the same file-backed database and reports
 * what they serve.
 *
 * Mode ADV_PI_CHILD=kill|control runs the child side; the parent side spawns it.
 */
import { describe, expect, it, mock } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestTempDirFromPath } from "../../plugin/src/shared/test-temp-dir";

const CHILD = process.env.ADV_PI_CHILD;
const DB_PATH = process.env.ADV_PI_DB;
const OUT = process.env.ADV_PI_OUT;
const SESSION = "ses-adv-pi-sigkill";
const BASE_MODEL = "anthropic/opus";
const HARD_MODEL = "anthropic/sonnet";
const BASE_SYSTEM_HASH = "sys-v1";

async function harness(dbPath: string) {
	const utils = await import("./test-utils.test");
	const ch = await import("./context-handler");
	const storage = await import(
		"@magic-context/core/features/magic-context/storage"
	);
	const db = utils.createTestDb(dbPath);
	const ids = ["e-1", "e-2", "e-3", "e-4", "e-5", "e-6"];
	const build = () =>
		[
			utils.userMessage("start", 1),
			utils.assistantToolCall("call-small", "bash", { command: "ls -la" }, 2),
			{
				...utils.toolResultMessage("call-small", "small output", 3),
				toolName: "bash",
			},
			utils.assistantToolCall(
				"call-large",
				"write",
				{ filePath: "/tmp/a.txt", content: "L".repeat(2000) },
				4,
			),
			{
				...utils.toolResultMessage("call-large", "wrote file", 5),
				toolName: "write",
			},
			utils.userMessage("next prompt", 6),
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
	const modes = () =>
		Object.fromEntries(
			storage
				.getTagsBySession(db, SESSION)
				.filter((t) => t.type === "tool")
				.map((t) => [t.tagNumber, `${t.status}/${t.dropMode}`]),
		);
	return { db, ch, storage, pass, modes };
}

describe("ADV Pi: SIGKILL between the HARD fold commit and legacy conversion", () => {
	if (CHILD) {
		it("child", async () => {
			if (CHILD === "kill") {
				const actual = await import(
					"@magic-context/core/hooks/magic-context/apply-operations"
				);
				const original = actual.convertLegacyToolSkeletons;
				mock.module(
					"@magic-context/core/hooks/magic-context/apply-operations",
					() => ({
						...actual,
						convertLegacyToolSkeletons: (
							...args: Parameters<typeof actual.convertLegacyToolSkeletons>
						) => {
							if (!(globalThis as { __advArmKill?: boolean }).__advArmKill) {
								return original(...args);
							}
							writeFileSync(
								`${OUT}.killpoint`,
								"reached conversion after fold commit\n",
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
				systemPromptHash: BASE_SYSTEM_HASH,
			});
			h.ch.recordPiLiveModel(SESSION, BASE_MODEL);
			await h.pass();
			const toolTags = h.storage
				.getTagsBySession(h.db, SESSION)
				.filter((t) => t.type === "tool")
				.map((t) => t.tagNumber);
			for (const tag of toolTags) {
				h.storage.updateTagStatus(h.db, SESSION, tag, "dropped");
				h.storage.updateTagDropMode(h.db, SESSION, tag, "truncated");
			}
			h.storage.updateSessionMeta(h.db, SESSION, {
				lastResponseTime: Date.now(),
				cacheTtl: "59m",
				lastContextPercentage: 40,
				lastInputTokens: 4_000,
			});
			const deferA = await h.pass();
			const deferB = await h.pass();
			writeFileSync(
				`${OUT}.defer`,
				JSON.stringify({ deferA, deferB, modes: h.modes() }),
			);
			h.ch.recordPiLiveModel(SESSION, HARD_MODEL);
			(globalThis as { __advArmKill?: boolean }).__advArmKill = true;
			const hard = await h.pass();
			writeFileSync(`${OUT}.hard`, JSON.stringify({ hard, modes: h.modes() }));
		}, 60_000);
		return;
	}

	for (const variant of ["kill", "control"] as const) {
		it(`parent: next passes after a ${variant} child`, async () => {
			const root = createTestTempDirFromPath(
				join(process.env.ADV_ROOT ?? tmpdir(), `pi-sigkill-${variant}-`),
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
						ADV_PI_CHILD: variant,
						ADV_PI_DB: dbPath,
						ADV_PI_OUT: out,
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
			h.ch.recordPiLiveModel(SESSION, HARD_MODEL);
			const modesBefore = h.modes();
			h.storage.updateSessionMeta(h.db, SESSION, {
				lastResponseTime: Date.now(),
			});
			const next1 = await h.pass();
			const next2 = await h.pass();
			const summary = {
				variant,
				childSignal: child.signal,
				childStatus: child.status,
				killpoint,
				deferModes: deferRec?.modes,
				deferIdentical: deferRec ? deferRec.deferA === deferRec.deferB : null,
				childHardServed: hardRec
					? hardRec.hard.includes('"dropped":')
						? "legacy-marker"
						: "converted"
					: "never-served",
				modesAfterRestart: modesBefore,
				modesAfterNext: h.modes(),
				next1LegacyMarker: next1.includes('"dropped":'),
				next1EqualsNext2: next1 === next2,
				next1EqualsChildHard: hardRec ? next1 === hardRec.hard : null,
				next1EqualsChildDefer: deferRec ? next1 === deferRec.deferA : null,
				next1Tail: next1.slice(-900),
			};
			console.log("ADV_PI_SIGKILL", JSON.stringify(summary, null, 1));
			writeFileSync(
				join(root, "summary.json"),
				JSON.stringify(summary, null, 2),
			);
			h.ch.clearContextHandlerSession(SESSION);
			if (variant === "kill") {
				expect(child.signal).toBe("SIGKILL");
				expect(killpoint).toContain("reached conversion");
			}
			expect(next1).toBe(next2);
		}, 120_000);
	}
});
