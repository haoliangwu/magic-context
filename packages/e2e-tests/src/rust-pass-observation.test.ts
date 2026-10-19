import { afterEach, expect, test } from "bun:test";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestTempDirFromPath } from "../../plugin/src/shared/test-temp-dir";
import {
	observeRustPassTurns,
	rustPassTurnsForFullBranch,
	waitForRustPassTurns,
} from "./rust-pass-observation";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});
const prompts = Array.from(
	{ length: 9 },
	(_, index) => `submitted turn ${index + 1}:`,
);
const messages = prompts.flatMap((prompt, index) => [
	{
		info: { id: `msg_${String(index * 2).padStart(3, "0")}`, role: "user" },
		parts: [{ type: "text", text: `${prompt} ballast` }],
	},
	{
		info: {
			id: `msg_${String(index * 2 + 1).padStart(3, "0")}`,
			role: "assistant",
		},
		parts: [{ type: "text", text: "reply" }],
	},
]);
const turns = rustPassTurnsForFullBranch(messages, prompts);
const passes = turns.map((turn) => ({
	inputCount: turn.inputCount,
	raw: `rust pass: in=${turn.inputCount} turn=${turn.turnId}`,
}));

function passAt(index: number) {
	const pass = passes[index];
	if (!pass) throw new Error(`Missing fixture pass ${index}`);
	return pass;
}

function logFixture() {
	const root = createTestTempDirFromPath(join(tmpdir(), "rust-pass-observation-"));
	roots.push(root);
	const path = join(root, "plugin.log");
	writeFileSync(path, "[]");
	return {
		path,
		read: () => JSON.parse(readFileSync(path, "utf8")) as typeof passes,
	};
}

test("Rust publication joins submitted host turn ids to full-branch input prefixes", () => {
	expect(turns.map((turn) => turn.turnId)).toEqual(
		prompts.map((_, index) => `msg_${String(index * 2).padStart(3, "0")}`),
	);
	expect(turns.map((turn) => turn.inputCount)).toEqual([
		1, 3, 5, 7, 9, 11, 13, 15, 17,
	]);
	expect(observeRustPassTurns(turns, passes).complete).toBe(true);
});

test("Rust publication does not mistake nine unrelated or duplicate entries for nine submitted turns", () => {
	const stale = [
		...passes.slice(0, 7),
		passAt(0),
		{ inputCount: 19, raw: "unrelated later turn" },
	];
	const observed = observeRustPassTurns(turns, stale);
	expect(stale).toHaveLength(9);
	expect(observed.complete).toBe(false);
	expect(
		observed.entries
			.filter((entry) => entry.observed.length === 0)
			.map((entry) => entry.turnId),
	).toEqual(["msg_014", "msg_016"]);
	expect(observed.unexpected).toEqual([
		{ inputCount: 19, raw: "unrelated later turn" },
	]);
});

test("Rust publication waits for a buffered outage batch before exposing the recovery baseline", async () => {
	const fixture = logFixture();
	writeFileSync(fixture.path, JSON.stringify(passes.slice(0, 7)));
	let resolved = false;
	const pending = waitForRustPassTurns(fixture.path, turns, fixture.read).then(
		(result) => {
			resolved = true;
			return result;
		},
	);
	await Promise.resolve();
	expect(resolved).toBe(false);
	// Publish the final two outage records as one batch, without a timed sleep.
	writeFileSync(fixture.path, JSON.stringify(passes));
	expect(await pending).toEqual(passes);
});

test("Rust publication timeout fails with the missing host turn ids and entries seen", async () => {
	const fixture = logFixture();
	writeFileSync(fixture.path, JSON.stringify(passes.slice(0, 7)));
	await expect(
		waitForRustPassTurns(fixture.path, turns, fixture.read, 0),
	).rejects.toThrow("msg_014");
	await expect(
		waitForRustPassTurns(fixture.path, turns, fixture.read, 0),
	).rejects.toThrow("rust pass: in=13 turn=msg_012");
});

test("Rust publication rejects an actual extra transform for a submitted turn", () => {
	const observed = observeRustPassTurns(turns, [...passes, passAt(8)]);
	expect(observed.complete).toBe(false);
	expect(observed.entries[8]?.observed).toHaveLength(2);
});
