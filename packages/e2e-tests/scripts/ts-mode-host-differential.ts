#!/usr/bin/env bun
/**
 * TypeScript-mode wire differential between two refs on OpenCode 2 or Pi.
 *
 * A user who never sets `transform_mode: "rust"` must see the same provider
 * requests before and after a change that only adds Rust-mode wiring. This
 * script extracts each ref into a throwaway directory, builds the plugin the
 * host loads from that ref, drives one scripted TypeScript-mode session, and
 * compares every main-agent request body and every host checkpoint the plugin
 * answered, byte for byte after normalising only per-run identity (session and
 * message ids, the throwaway paths).
 *
 * The scenario: two warm turns, three appended turns that stay below the
 * execute threshold (defer), one turn reported at high usage so the next pass
 * executes (and, on OpenCode 2, the host asks the compaction hook for a
 * checkpoint), two more turns, then a host restart and one final turn.
 * Historian, dreamer, memory and temporal awareness are off so the only moving
 * part is the transform itself.
 *
 * Usage:
 *   bun packages/e2e-tests/scripts/ts-mode-host-differential.ts --host oc2 <left-ref> <right-ref>
 *   bun packages/e2e-tests/scripts/ts-mode-host-differential.ts --host pi  <left-ref> <right-ref>
 * Every host root is created under $TMPDIR; run it with TMPDIR pointed at a
 * throwaway directory.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	copyFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REPO_ROOT = resolve(dirname(SCRIPT_PATH), "../../..");
const RESULT_PREFIX = "TS_HOST_DIFF_RESULT=";
const sha = (text: string) => createHash("sha256").update(text).digest("hex");

function valueAfter(flag: string): string | undefined {
	const index = Bun.argv.indexOf(flag);
	return index === -1 ? undefined : Bun.argv[index + 1];
}
const hostKind = (valueAfter("--host") ?? "oc2") as "oc2" | "pi";

type Capture = {
	ref: string;
	turns: Array<{
		turn: string;
		bytes: number;
		sha256: string;
		normalized: string;
	}>;
	checkpoints: string[];
	hookLines: string[];
	failedTurns: number;
};

/** Replace per-run identity so two runs of the same code compare equal. */
function normalizer(roots: string[]) {
	const ids = new Map<string, string>();
	return (text: string): string => {
		let out = text;
		for (const root of roots
			.filter(Boolean)
			.sort((a, b) => b.length - a.length))
			out = out.split(root).join("<ROOT>");
		out = out.replace(
			/\b(ses|msg|prt|call|toolu|evt|cmp|resp|fc|rs)_[A-Za-z0-9_]{6,}/g,
			(match) => {
				let mapped = ids.get(match);
				if (!mapped) {
					mapped = `<${match.split("_")[0]}#${ids.size}>`;
					ids.set(match, mapped);
				}
				return mapped;
			},
		);
		// Pi session ids are UUIDs.
		out = out.replace(
			/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g,
			(match) => {
				let mapped = ids.get(match);
				if (!mapped) {
					mapped = `<uuid#${ids.size}>`;
					ids.set(match, mapped);
				}
				return mapped;
			},
		);
		return out;
	};
}

const BALLAST = [
	"boundary",
	"historian",
	"compartment",
	"schedule",
	"pressure",
	"tokens",
	"window",
	"publish",
	"transform",
	"session",
	"marker",
	"budget",
	"eligible",
];
function ballast(tokens: number, seed: number): string {
	const parts: string[] = [];
	let length = 0;
	for (let index = 0; length < tokens * 4; index += 1) {
		const word = BALLAST[(index + seed) % BALLAST.length]!;
		parts.push(index % 17 === 0 ? `${word}.` : word);
		length += word.length + 1;
	}
	return parts.join(" ");
}

const MC_CONFIG = {
	memory: { enabled: false, auto_search: { enabled: false } },
	dreamer: { disable: true, inject_docs: false },
	historian: { disable: true },
	temporal_awareness: false,
	compressor: { enabled: false },
	execute_threshold_percentage: 40,
	history_budget_percentage: 0.15,
};

const TURNS: Array<{ label: string; tokens: number; usage: number }> = [
	{ label: "warm-0", tokens: 10, usage: 1_000 },
	{ label: "warm-1", tokens: 10, usage: 1_000 },
	{ label: "append-0", tokens: 1_500, usage: 3_000 },
	{ label: "append-1", tokens: 1_500, usage: 5_000 },
	{ label: "append-2", tokens: 1_500, usage: 7_000 },
	{ label: "priced", tokens: 1_500, usage: 23_000 },
	{ label: "after-priced-0", tokens: 1_500, usage: 23_000 },
	{ label: "after-priced-1", tokens: 1_500, usage: 8_000 },
];

function lastRequestWith(
	requests: Array<{ body: Record<string, unknown> }>,
	marker: string,
) {
	return [...requests]
		.reverse()
		.find((request) => JSON.stringify(request.body).includes(marker));
}

async function captureOc2(ref: string): Promise<Capture> {
	const { isolation, spawnOpencode2 } = await import(
		"../src/opencode2-runner/spawn"
	);
	const { OpenCode } = await import("@opencode/client");
	const { Database } = await import("bun:sqlite");
	const fixture = isolation();
	const logPath = join(fixture.env.XDG_DATA_HOME!, "mc-ts-diff.log");
	fixture.env.MAGIC_CONTEXT_LOG_PATH = logPath;
	let usage = 1_000;
	let host = await spawnOpencode2({
		existingIsolation: fixture,
		modelContextLimit: 24_000,
		modelOutputLimit: 1_024,
		magicContextConfig: MC_CONFIG,
	});
	host.mock.addMatcher(() => ({
		text: "ok",
		usage: { input_tokens: usage, output_tokens: 20 },
	}));
	const normalize = normalizer([
		fixture.root,
		host.cwd,
		fixture.env.XDG_DATA_HOME!,
	]);
	const clientFor = () =>
		OpenCode.make({
			baseUrl: host.url,
			headers: { authorization: `Basic ${btoa(`opencode:${host.password}`)}` },
		});
	let client = clientFor();
	const session = await client.session.create({
		location: { directory: host.cwd },
		model: { providerID: "openai", id: "mock-model" },
	});
	const turns: Capture["turns"] = [];
	const run = async (
		label: string,
		tokens: number,
		nextUsage: number,
		seed: number,
	) => {
		const marker = `[[ts-diff-${label}]]`;
		await client.session.prompt({
			sessionID: session.id,
			text: `${marker} ${ballast(tokens, seed)}`,
		});
		await client.session.wait(
			{ sessionID: session.id },
			{ signal: AbortSignal.timeout(180_000) },
		);
		const request = lastRequestWith(host.mock.requests(), marker);
		if (!request) {
			// A turn the host ended without asking the provider is itself the
			// observation: record it and keep going so both refs are compared.
			turns.push({
				turn: label,
				bytes: 0,
				sha256: "NO-PROVIDER-REQUEST",
				normalized: "",
			});
			usage = nextUsage;
			return;
		}
		const wire = JSON.stringify(request.body);
		const normalized = normalize(wire);
		turns.push({
			turn: label,
			bytes: Buffer.byteLength(wire),
			sha256: sha(normalized),
			normalized,
		});
		usage = nextUsage;
	};
	for (const [index, turn] of TURNS.entries())
		await run(turn.label, turn.tokens, turn.usage, index);
	await host.stopHost();
	host = await spawnOpencode2({
		existingIsolation: { root: fixture.root, env: host.env, cwd: host.cwd },
		existingMock: { mock: host.mock, baseURL: host.mockBaseURL },
		modelContextLimit: 24_000,
		modelOutputLimit: 1_024,
		magicContextConfig: MC_CONFIG,
	});
	client = clientFor();
	await run("after-restart", 200, 8_000, 99);
	await Bun.sleep(1_500);
	const dbPath = join(fixture.env.XDG_DATA_HOME!, "opencode", "opencode2.db");
	const db = new Database(dbPath, { readonly: true });
	const checkpoints = (
		db
			.prepare(
				"SELECT data FROM session_message WHERE session_id = ? AND type = 'compaction' ORDER BY seq",
			)
			.all(session.id) as Array<{ data: string }>
	).map((row) => {
		const data = JSON.parse(row.data) as { status?: string; summary?: string };
		return normalize(`${data.status}|${data.summary ?? ""}`);
	});
	const failedTurns = (
		db
			.prepare(
				"SELECT COUNT(*) AS n FROM session_message WHERE session_id = ? AND type = 'idle' AND json_extract(data, '$.outcome') = 'failed'",
			)
			.get(session.id) as { n: number }
	).n;
	db.close();
	const hookLines = existsSync(logPath)
		? readFileSync(logPath, "utf8")
				.split("\n")
				.filter((line) => line.includes("v2 compaction hook"))
				.map((line) => line.slice(line.indexOf("v2 compaction hook")))
		: [];
	await host.stop();
	return { ref, turns, checkpoints, hookLines, failedTurns };
}

async function capturePi(ref: string): Promise<Capture> {
	const { PiTestHarness } = await import("../src/pi-harness");
	let usage = 1_000;
	const harness = await PiTestHarness.create({
		modelContextLimit: 24_000,
		magicContextConfig: MC_CONFIG,
	});
	harness.mock.addMatcher(() => ({
		text: "ok",
		usage: { input_tokens: usage, output_tokens: 20 },
	}));
	const normalize = normalizer([harness.env.baseDir, harness.env.workdir]);
	const turns: Capture["turns"] = [];
	const sessionId = await harness.createSession();
	const run = async (
		label: string,
		tokens: number,
		nextUsage: number,
		seed: number,
	) => {
		const marker = `[[ts-diff-${label}]]`;
		await harness.sendPrompt(sessionId, `${marker} ${ballast(tokens, seed)}`);
		const request = lastRequestWith(harness.mock.requests(), marker);
		if (!request) throw new Error(`no provider request carried ${marker}`);
		const wire = JSON.stringify(request.body);
		const normalized = normalize(wire);
		turns.push({
			turn: label,
			bytes: Buffer.byteLength(wire),
			sha256: sha(normalized),
			normalized,
		});
		usage = nextUsage;
	};
	try {
		for (const [index, turn] of TURNS.entries())
			await run(turn.label, turn.tokens, turn.usage, index);
	} finally {
		await harness.dispose();
	}
	return { ref, turns, checkpoints: [], hookLines: [], failedTurns: 0 };
}

function extractAndBuild(ref: string, destination: string): void {
	mkdirSync(destination, { recursive: true });
	const archive = execFileSync("git", ["archive", "--format=tar", ref], {
		cwd: REPO_ROOT,
		maxBuffer: 512 * 1024 * 1024,
	});
	execFileSync("tar", ["-xf", "-", "-C", destination], {
		input: archive,
		maxBuffer: 512 * 1024 * 1024,
	});
	if (existsSync(join(REPO_ROOT, "node_modules")))
		symlinkSync(
			join(REPO_ROOT, "node_modules"),
			join(destination, "node_modules"),
			"dir",
		);
	for (const name of ["e2e-tests", "plugin", "pi-plugin", "retina-local-fs"]) {
		const source = join(REPO_ROOT, "packages", name, "node_modules");
		if (existsSync(source))
			symlinkSync(
				source,
				join(destination, "packages", name, "node_modules"),
				"dir",
			);
	}
	copyFileSync(
		SCRIPT_PATH,
		join(
			destination,
			"packages/e2e-tests/scripts/ts-mode-host-differential.ts",
		),
	);
	const build = (cwd: string, args: string[]) => {
		const child = spawnSync(process.execPath, args, {
			cwd,
			encoding: "utf8",
			maxBuffer: 64 * 1024 * 1024,
		});
		if (child.status !== 0)
			throw new Error(
				`build failed in ${cwd}: ${args.join(" ")}\n${child.stdout}\n${child.stderr}`,
			);
	};
	if (hostKind === "oc2") {
		// The host loads the package entry (index.js -> dist/index.js), which
		// hands over to dist/v2/server.js; both come from the full build.
		build(join(destination, "packages/plugin"), ["run", "build"]);
	} else {
		build(join(destination, "packages/pi-plugin"), ["run", "build"]);
	}
}

const singleRef = valueAfter("--single-ref");
if (singleRef) {
	const result =
		hostKind === "oc2"
			? await captureOc2(singleRef)
			: await capturePi(singleRef);
	// A host that failed to load the plugin serves the raw conversation, and two
	// raw conversations compare equal for the wrong reason. Refuse that outcome.
	if (
		!result.turns.some((turn) =>
			/<session-history>|<conversation-checkpoint>|\u00a7\d+\u00a7|§\d+§/.test(
				turn.normalized,
			),
		)
	)
		throw new Error(
			`Magic Context never transformed a request on ${singleRef}; the plugin did not load`,
		);
	console.log(`${RESULT_PREFIX}${JSON.stringify(result)}`);
	process.exit(0);
}

const refs = Bun.argv
	.slice(2)
	.filter(
		(arg, index, all) => !arg.startsWith("--") && all[index - 1] !== "--host",
	);
if (refs.length !== 2) {
	console.error(
		"usage: ts-mode-host-differential.ts --host oc2|pi <left-ref> <right-ref>",
	);
	process.exit(2);
}
const sharedRoot = mkdtempSync(join(tmpdir(), `ts-host-diff-${hostKind}-`));
const captures: Capture[] = [];
try {
	for (const [slot, ref] of [
		["left", refs[0]!],
		["right", refs[1]!],
	] as const) {
		const destination = join(sharedRoot, slot);
		extractAndBuild(ref, destination);
		const child = spawnSync(
			process.execPath,
			[
				"packages/e2e-tests/scripts/ts-mode-host-differential.ts",
				"--host",
				hostKind,
				"--single-ref",
				ref,
			],
			{
				cwd: destination,
				encoding: "utf8",
				maxBuffer: 256 * 1024 * 1024,
				env: process.env,
			},
		);
		const line = child.stdout
			.split("\n")
			.find((entry) => entry.startsWith(RESULT_PREFIX));
		if (child.status !== 0 || !line)
			throw new Error(
				`capture failed for ${ref}\n${child.stdout.slice(-4000)}\n${child.stderr.slice(-4000)}`,
			);
		captures.push(JSON.parse(line.slice(RESULT_PREFIX.length)) as Capture);
	}
	const [left, right] = captures as [Capture, Capture];
	let identical = left.turns.length === right.turns.length;
	for (
		let index = 0;
		index < Math.max(left.turns.length, right.turns.length);
		index += 1
	) {
		const l = left.turns[index];
		const r = right.turns[index];
		const same = !!l && !!r && l.sha256 === r.sha256;
		identical &&= same;
		console.log(
			`TURN ${l?.turn ?? r?.turn} ${same ? "IDENTICAL" : "DIVERGENT"} left_bytes=${l?.bytes} right_bytes=${r?.bytes} left=${l?.sha256.slice(0, 16)} right=${r?.sha256.slice(0, 16)}`,
		);
		if (!same && l && r) {
			let at = 0;
			while (at < l.normalized.length && l.normalized[at] === r.normalized[at])
				at += 1;
			console.log(
				`  first difference at ${at}:\n  left : ${l.normalized.slice(Math.max(0, at - 120), at + 200)}\n  right: ${r.normalized.slice(Math.max(0, at - 120), at + 200)}`,
			);
		}
	}
	const checkpointsSame =
		JSON.stringify(left.checkpoints) === JSON.stringify(right.checkpoints);
	identical &&= checkpointsSame;
	console.log(
		`CHECKPOINTS ${checkpointsSame ? "IDENTICAL" : "DIVERGENT"} left=${left.checkpoints.length} right=${right.checkpoints.length}`,
	);
	console.log(
		`HOOK LINES left=${JSON.stringify(left.hookLines)}\nHOOK LINES right=${JSON.stringify(right.hookLines)}`,
	);
	console.log(
		`FAILED TURNS left=${left.failedTurns} right=${right.failedTurns}`,
	);
	console.log(`RESULT ${identical ? "IDENTICAL" : "DIVERGENT"}`);
	process.exitCode = identical ? 0 : 1;
} finally {
	if (!process.env.KEEP_DIFF_ROOT)
		rmSync(sharedRoot, { recursive: true, force: true });
	else console.log(`kept ${sharedRoot}`);
}
