import { expect, it, spyOn } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { updateSessionMeta } from "@magic-context/core/features/magic-context/storage";
import { getCurrentSystemPrompt, getCurrentTools } from "pi-ai-086";
import { createTestTempDirFromPath } from "../../plugin/src/shared/test-temp-dir";
import {
	clearContextHandlerSession,
	registerPiContextHandler,
} from "./context-handler";
import {
	assistantMessage,
	createFakePi,
	createTestDb,
	fakeContext,
	userMessage,
} from "./test-utils.test";

it.skipIf(!process.env.MC_GATE_PURE)("F pure replay child", async () => {
	const clock = spyOn(Date, "now").mockReturnValue(1800000000000);
	const db = createTestDb();
	const sid = "gate-pure";
	try {
		const fake = createFakePi();
		registerPiContextHandler(fake.pi as never, {
			db,
			protectedTags: 0,
			injection: { injectionBudgetTokens: 10000 },
		});
		const handler = fake.handlers.get("context") as (
			event: { messages: unknown[] },
			ctx: unknown,
		) => Promise<{ messages: unknown[] }>;
		const raw = [
			userMessage("old", 1),
			assistantMessage("answer", 2),
			userMessage("tail", 3),
		];
		const passes = [];
		for (let pass = 0; pass < 6; pass++) {
			if (pass === 5) clearContextHandlerSession(sid);
			const messages = structuredClone(raw);
			const served = await handler(
				{ messages },
				{
					...fakeContext(
						sid,
						process.env.MC_GATE_EMPTY,
						["u0", "a0", "u1"],
						messages,
					),
					getContextUsage: () => ({
						tokens: pass ? 10000 : 70000,
						percent: pass ? 10 : 70,
						contextWindow: 100000,
					}),
				},
			);
			passes.push({
				pass,
				sha256: createHash("sha256")
					.update(JSON.stringify(served.messages))
					.digest("hex"),
				tools: getCurrentTools(served.messages as never),
				prompt: getCurrentSystemPrompt(served.messages as never),
				served: served.messages,
			});
			updateSessionMeta(db, sid, {
				lastResponseTime: Date.now(),
				cacheTtl: "59m",
				lastContextPercentage: 10,
				lastInputTokens: 10000,
			});
		}
		console.log(`PURE_GATE=${JSON.stringify(passes)}`);
	} finally {
		clearContextHandlerSession(sid);
		db.close();
		clock.mockRestore();
	}
});

// SHA-256 of the committed fixture's bytes. The fixture records what the Pi lane
// served immediately BEFORE the issue 485 system-message rework, so a change that
// alters a no-system replay has to change the fixture to stay green — and this pin
// makes that edit impossible to slip through unnoticed. Regenerate both together
// with scripts/generate-issue-485-pre-fix-fixture.ts, which prints the new value.
const PRE_FIX_FIXTURE_SHA256 =
	"2894b16e4bc059211132f5f592e60b4ee0306cd58f56090db15a191c57a5d68f";

it("F no-system served arrays equal pre-fix master on every replay", () => {
	// The baseline is read from committed bytes, never from repository history: CI
	// checkouts are shallow, and a test that resolves a commit passes or fails on
	// what the checkout happens to contain rather than on the code under test.
	const fixtureBytes = readFileSync(
		join(import.meta.dir, "fixtures/issue-485-pre-fix-served-arrays.json"),
	);
	expect(createHash("sha256").update(fixtureBytes).digest("hex")).toBe(
		PRE_FIX_FIXTURE_SHA256,
	);
	const preFix = JSON.parse(fixtureBytes.toString("utf8")) as {
		baselineCommit: string;
		passes: unknown[];
	};

	// An empty directory as the session cwd — the same one the fixture was recorded
	// against — so nothing about the machine running the replay can reach the
	// served array.
	const empty = createTestTempDirFromPath(join(tmpdir(), "issue-485-empty-"));
	try {
		const child = Bun.spawnSync(
			[process.execPath, "test", import.meta.path, "-t", "F pure replay child"],
			{
				windowsHide: true,
				cwd: import.meta.dir,
				env: { ...process.env, MC_GATE_PURE: "1", MC_GATE_EMPTY: empty },
				stdout: "pipe",
				stderr: "pipe",
			},
		);
		if (child.exitCode !== 0) throw new Error(child.stderr.toString());
		const line = child.stdout
			.toString()
			.split("\n")
			.find((candidate) => candidate.startsWith("PURE_GATE="));
		if (!line) throw new Error("No pure replay output");
		const current: unknown[] = JSON.parse(line.slice("PURE_GATE=".length));
		console.log(
			`GATE F baseline=${preFix.baselineCommit} passes=${current.length}`,
		);
		// toEqual first for a readable diff, then the serialized form so the
		// assertion is on the served bytes and not just on structural equality.
		expect(current).toEqual(preFix.passes);
		expect(JSON.stringify(current)).toBe(JSON.stringify(preFix.passes));
	} finally {
		rmSync(empty, { recursive: true, force: true });
	}
});
