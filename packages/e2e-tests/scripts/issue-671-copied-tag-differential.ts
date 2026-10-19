#!/usr/bin/env bun
/**
 * Served-bytes evidence for stripping copied `§N§` notation from OpenCode 2
 * assistant text (issue 671). Two checks, both on a real OpenCode 2 host:
 *
 * 1. Identity. A scripted session whose assistant replies never contain a `§`
 *    must send byte-identical provider requests from both refs. The replies are
 *    ordinary assistant prose: markdown, lists, code fences, numbers at the start
 *    of a line, surrounding whitespace, non-ASCII text. Most turns stay below the
 *    execute threshold (defer passes). A few report high usage so the next pass
 *    executes, and the host restarts once mid-session.
 * 2. Upgrade. A session whose model copied tags runs on the left ref, then the
 *    same store continues on the right ref. The first request after the upgrade
 *    may differ once. Every later request must repeat the previous one byte for
 *    byte.
 *
 * Each ref is extracted with `git archive` into a throwaway directory and built
 * there. The host loads that build. Requests are compared after replacing only
 * per-run identity (session and message ids, the throwaway paths).
 *
 * Usage (every host root is created under $TMPDIR; point it at a throwaway directory):
 *   bun packages/e2e-tests/scripts/issue-671-copied-tag-differential.ts <left-ref> <right-ref> [--turns 300]
 */
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Database } from "bun:sqlite";
import { OpenCode } from "@opencode/client";
import { isolation, spawnOpencode2 } from "../src/opencode2-runner/spawn";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const sha = (text: string) => createHash("sha256").update(text).digest("hex");

function valueAfter(flag: string): string | undefined {
	const index = Bun.argv.indexOf(flag);
	return index === -1 ? undefined : Bun.argv[index + 1];
}
const TURNS = Number(valueAfter("--turns") ?? 300);
const refs = Bun.argv.slice(2).filter((arg, index, all) => !arg.startsWith("--") && all[index - 1] !== "--turns");
if (refs.length !== 2) {
	console.error("usage: issue-671-copied-tag-differential.ts <left-ref> <right-ref> [--turns N]");
	process.exit(2);
}

/** Replace per-run identity so two runs of the same code compare equal. */
function normalizer(roots: string[]) {
	const ids = new Map<string, string>();
	return (text: string): string => {
		let out = text;
		for (const root of roots.filter(Boolean).sort((a, b) => b.length - a.length)) out = out.split(root).join("<ROOT>");
		return out.replace(/\b(ses|msg|prt|call|toolu|evt|cmp|resp|fc|rs)_[A-Za-z0-9_]{6,}/g, (match) => {
			let mapped = ids.get(match);
			if (!mapped) {
				mapped = `<${match.split("_")[0]}#${ids.size}>`;
				ids.set(match, mapped);
			}
			return mapped;
		});
	};
}

/** Deterministic generator, so both refs see the same conversation. */
function generator(seed: number) {
	let state = seed >>> 0 || 1;
	const next = () => {
		state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
		return state / 2 ** 32;
	};
	const pick = <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)]!;
	return { next, pick };
}

const FRAGMENTS = [
	"I updated 3 files and ran the suite again; 99 tests passed and 2 were skipped.",
	"## Summary\n\nThe parser now keeps the original byte offsets.",
	"1. Read `src/config/loader.ts:42`\n2. Fix the default\n3. Re-run `bun test`",
	"- [x] migrate the schema\n- [ ] backfill old rows\n- [ ] update the docs",
	"```ts\nexport function total(items: number[]): number {\n    return items.reduce((sum, n) => sum + n, 0);\n}\n```",
	"```rust\nfn main() {\n    println!(\"{}\", 2024);\n}\n```",
	"```sh\ngit diff --stat HEAD~1 && cargo check -p core\n```",
	"| file | lines |\n| --- | --- |\n| a.ts | 120 |\n| b.ts | 48 |",
	"Section 5.1 of the spec says the header is optional; see https://example.com/spec#5.1 for details.",
	"2024 roadmap items are tracked in the issue; 6 8 9 tasks from the todo list are done.",
	"Café, naïve, Zürich, 日本語のテキスト, and ✅ all round-trip unchanged.",
	'{"status": "ok", "count": 17, "path": "/tmp/x"}',
	"Costs went from $4.20 to $3.10 (a 26% drop) after the cache fix.",
	"I could not reproduce it locally. Could you share the full log?",
	"> Note: this only affects the second request after a restart.",
	"Done.",
];
const PADDING = ["", " ", "\n", "\n\n", "  \n", "\t"];

function assistantReply(turn: number): string {
	const g = generator(turn * 7919 + 17);
	const count = 1 + Math.floor(g.next() * 5);
	const body = Array.from({ length: count }, () => g.pick(FRAGMENTS)).join(g.pick(["\n\n", "\n", " "]));
	// Leading and trailing whitespace is part of ordinary replies; a strip that
	// trimmed text without tag notation would change these bytes.
	return `${g.pick(PADDING)}${body}${g.pick(PADDING)}`;
}

function userPrompt(turn: number): string {
	const g = generator(turn * 104729 + 3);
	return `[[issue-671-turn-${turn}]] ${g.pick(["Please continue.", "What changed in the last step?", "Run the tests again and summarize.", "Why did that fail?", "Show me the diff for the parser."])}`;
}

const MC_CONFIG = {
	memory: { enabled: false, auto_search: { enabled: false } },
	dreamer: { disable: true, inject_docs: false },
	historian: { disable: true },
	temporal_awareness: false,
	compressor: { enabled: false },
};

function extractAndBuild(ref: string, destination: string): string {
	mkdirSync(destination, { recursive: true });
	const archive = execFileSync("git", ["archive", "--format=tar", ref], {
		cwd: REPO_ROOT,
		maxBuffer: 512 * 1024 * 1024,
	});
	execFileSync("tar", ["-xf", "-", "-C", destination], { input: archive, maxBuffer: 512 * 1024 * 1024 });
	if (existsSync(join(REPO_ROOT, "node_modules")))
		symlinkSync(join(REPO_ROOT, "node_modules"), join(destination, "node_modules"), "dir");
	// The plugin build also compiles packages/retina-local-fs, so link every
	// package's installed modules, not just the plugin's.
	for (const name of ["e2e-tests", "plugin", "pi-plugin", "retina-local-fs"]) {
		const source = join(REPO_ROOT, "packages", name, "node_modules");
		if (existsSync(source)) symlinkSync(source, join(destination, "packages", name, "node_modules"), "dir");
	}
	const plugin = join(destination, "packages/plugin");
	const build = spawnSync(process.execPath, ["run", "build"], { cwd: plugin, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
	if (build.status !== 0) throw new Error(`build failed for ${ref}\n${build.stdout}\n${build.stderr}`);
	return plugin;
}

type Turn = { turn: number; bytes: number; sha256: string; normalized: string };

async function identityRun(plugin: string): Promise<{ turns: Turn[]; deferPasses: number; executePasses: number }> {
	const fixture = isolation();
	const options = { existingIsolation: fixture, magicContextPlugin: plugin, magicContextConfig: MC_CONFIG };
	let host = await spawnOpencode2(options);
	let usage = 1_000;
	host.mock.addMatcher((body) => {
		// The newest prompt is the last marker in the request.
		const markers = [...JSON.stringify(body).matchAll(/\[\[issue-671-turn-(\d+)\]\]/g)];
		const turn = markers.length ? Number(markers.at(-1)![1]) : -1;
		return { text: turn >= 0 ? assistantReply(turn) : "title", usage: { input_tokens: usage, output_tokens: 20 } };
	});
	const normalize = normalizer([fixture.root, host.cwd, fixture.env.XDG_DATA_HOME!]);
	const clientFor = () =>
		OpenCode.make({ baseUrl: host.url, headers: { authorization: `Basic ${btoa(`opencode:${host.password}`)}` } });
	let client = clientFor();
	const session = await client.session.create({
		location: { directory: host.cwd },
		model: { providerID: "openai", id: "mock-model" },
	});
	const turns: Turn[] = [];
	for (let turn = 0; turn < TURNS; turn += 1) {
		if (turn === Math.floor(TURNS / 2)) {
			await host.stopHost();
			host = await spawnOpencode2({
				...options,
				existingIsolation: { root: fixture.root, env: host.env, cwd: host.cwd },
				existingMock: { mock: host.mock, baseURL: host.mockBaseURL },
			});
			client = clientFor();
		}
		// Every 100th turn the mock reports 150k input tokens, 75% of the 200k
		// window and over the 40% execute threshold the harness configures, so the next
		// pass is an execute pass (one allowed to rewrite already-sent history).
		usage = turn % 100 === 99 ? 150_000 : 1_000 + turn * 10;
		const marker = `[[issue-671-turn-${turn}]]`;
		await client.session.prompt({ sessionID: session.id, text: userPrompt(turn) });
		await client.session.wait({ sessionID: session.id }, { signal: AbortSignal.timeout(120_000) });
		const request = [...host.mock.requests()].reverse().find((entry) => JSON.stringify(entry.body).includes(marker));
		if (!request) throw new Error(`no provider request carried ${marker}`);
		const wire = JSON.stringify(request.body);
		const normalized = normalize(wire);
		turns.push({ turn, bytes: Buffer.byteLength(wire), sha256: sha(normalized), normalized });
	}
	const log = readFileSync(join(fixture.root, "magic-context.log"), "utf8").split("\n");
	const deferPasses = log.filter((line) => line.includes("pending ops WILL NOT APPLY — reason=scheduler_defer")).length;
	const executePasses = log.filter((line) => line.includes("pending ops WILL APPLY")).length;
	await host.stop();
	if (!turns.some((turn) => /<session-history>|§\d+§/.test(turn.normalized)))
		throw new Error(`Magic Context never transformed a request with ${plugin}; the plugin did not load`);
	return { turns, deferPasses, executePasses };
}

const COPY_REPLIES = ["§12§ §12§ Done", "see §40827§ here", "plain reply"];

async function upgradeRun(leftPlugin: string, rightPlugin: string) {
	const fixture = isolation();
	let host = await spawnOpencode2({ existingIsolation: fixture, magicContextPlugin: leftPlugin, magicContextConfig: MC_CONFIG });
	let reply = "title";
	host.mock.addMatcher(() => ({ text: reply, usage: { input_tokens: 1_000, output_tokens: 20 } }));
	const clientFor = () =>
		OpenCode.make({ baseUrl: host.url, headers: { authorization: `Basic ${btoa(`opencode:${host.password}`)}` } });
	let client = clientFor();
	const session = await client.session.create({
		location: { directory: host.cwd },
		model: { providerID: "openai", id: "mock-model" },
	});
	const inputs: Array<{ ref: "left" | "right"; input: unknown[] }> = [];
	const turn = async (index: number, ref: "left" | "right", text: string) => {
		reply = text;
		const marker = `[[upgrade-${index}]]`;
		await client.session.prompt({ sessionID: session.id, text: `${marker} question` });
		await client.session.wait({ sessionID: session.id }, { signal: AbortSignal.timeout(60_000) });
		const request = [...host.mock.requests()].reverse().find((entry) => JSON.stringify(entry.body).includes(marker));
		inputs.push({ ref, input: (request?.body.input as unknown[]) ?? [] });
	};
	for (const [index, text] of COPY_REPLIES.entries()) await turn(index, "left", text);
	await host.stopHost();
	host = await spawnOpencode2({
		existingIsolation: { root: fixture.root, env: host.env, cwd: host.cwd },
		existingMock: { mock: host.mock, baseURL: host.mockBaseURL },
		magicContextPlugin: rightPlugin,
		magicContextConfig: MC_CONFIG,
	});
	client = clientFor();
	for (let index = 0; index < 4; index += 1) await turn(COPY_REPLIES.length + index, "right", `after upgrade ${index}`);
	const store = new Database(join(fixture.env.XDG_DATA_HOME!, "opencode", fixture.env.OPENCODE_DB!), { readonly: true });
	const stored = (
		store
			.prepare("SELECT data FROM session_message WHERE session_id = ? AND type = 'assistant' ORDER BY seq")
			.all(session.id) as Array<{ data: string }>
	).map((row) =>
		(JSON.parse(row.data).content as Array<{ type: string; text?: string }>)
			.filter((part) => part.type === "text")
			.map((part) => part.text)
			.join(""),
	);
	store.close();
	const log = readFileSync(join(fixture.root, "magic-context.log"), "utf8").split("\n");
	const sessionLines = log.filter((line) => line.includes(session.id));
	await host.stop();
	return { inputs, stored, sessionLines };
}

const sharedRoot = mkdtempSync(join(tmpdir(), "issue-671-diff-"));
try {
	const leftPlugin = extractAndBuild(refs[0]!, join(sharedRoot, "left"));
	const rightPlugin = extractAndBuild(refs[1]!, join(sharedRoot, "right"));

	const left = await identityRun(leftPlugin);
	const right = await identityRun(rightPlugin);
	let divergent = left.turns.length === right.turns.length ? 0 : 1;
	for (let index = 0; index < Math.max(left.turns.length, right.turns.length); index += 1) {
		const l = left.turns[index];
		const r = right.turns[index];
		if (l && r && l.sha256 === r.sha256) continue;
		divergent += 1;
		let at = 0;
		while (l && r && at < l.normalized.length && l.normalized[at] === r.normalized[at]) at += 1;
		console.log(
			`TURN ${index} DIVERGENT at ${at}\n  left : ${l?.normalized.slice(Math.max(0, at - 120), at + 200)}\n  right: ${r?.normalized.slice(Math.max(0, at - 120), at + 200)}`,
		);
	}
	const withSection = left.turns.filter((turn) => turn.normalized.includes("§")).length;
	console.log(
		`IDENTITY turns=${left.turns.length}/${right.turns.length} divergent=${divergent} left_defer=${left.deferPasses} right_defer=${right.deferPasses} left_execute=${left.executePasses} right_execute=${right.executePasses} requests_with_tag_prefixes=${withSection} last_request_bytes=${left.turns.at(-1)?.bytes}/${right.turns.at(-1)?.bytes} last_sha=${left.turns.at(-1)?.sha256.slice(0, 16)}/${right.turns.at(-1)?.sha256.slice(0, 16)}`,
	);

	const upgrade = await upgradeRun(leftPlugin, rightPlugin);
	const texts = (input: unknown[]) =>
		(input as Array<{ role?: string; content?: Array<{ text?: string }> }>)
			.filter((item) => item.role === "assistant")
			.map((item) => (item.content ?? []).map((part) => part.text ?? "").join(""));
	for (const [index, entry] of upgrade.inputs.entries())
		console.log(`UPGRADE request ${index + 1} (${entry.ref}) assistant text: ${JSON.stringify(texts(entry.input))}`);
	const rightInputs = upgrade.inputs.filter((entry) => entry.ref === "right");
	let stableAfterUpgrade = true;
	for (let index = 1; index < rightInputs.length; index += 1) {
		const previous = rightInputs[index - 1]!.input;
		const same =
			JSON.stringify(rightInputs[index]!.input.slice(0, previous.length)) === JSON.stringify(previous);
		console.log(`UPGRADE right request ${index + 1} repeats request ${index}: ${same}`);
		stableAfterUpgrade &&= same;
	}
	const lastLeft = upgrade.inputs.filter((entry) => entry.ref === "left").at(-1)!.input;
	const firstRight = rightInputs[0]!.input;
	console.log(
		`UPGRADE first right request repeats last left request: ${JSON.stringify(firstRight.slice(0, lastLeft.length)) === JSON.stringify(lastLeft)}`,
	);
	console.log(`UPGRADE stored assistant text: ${JSON.stringify(upgrade.stored)}`);
	const passLines = upgrade.sessionLines.filter((line) => line.includes("pending ops WILL"));
	console.log(`UPGRADE pass decisions: ${JSON.stringify(passLines.map((line) => line.slice(line.indexOf("pending ops"))))}`);
	const copiesAfterUpgrade = rightInputs.some((entry) => /§12§ §12§|§40827§/.test(JSON.stringify(entry.input)));
	console.log(`UPGRADE copies on the wire after upgrade: ${copiesAfterUpgrade}`);
	const ok = divergent === 0 && stableAfterUpgrade && !copiesAfterUpgrade;
	console.log(`RESULT ${ok ? "PASS" : "FAIL"}`);
	process.exitCode = ok ? 0 : 1;
} finally {
	if (!process.env.KEEP_DIFF_ROOT) rmSync(sharedRoot, { recursive: true, force: true });
	else console.log(`kept ${sharedRoot}`);
}
