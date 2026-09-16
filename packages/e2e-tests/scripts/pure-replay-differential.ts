#!/usr/bin/env bun

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
	writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

type ReplayPass = {
	pass: number;
	decision: string | null;
	bytes: number;
	sha256: string;
};

type RefReplay = {
	ref: string;
	commit: string;
	passes: ReplayPass[];
};

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REPO_ROOT = resolve(dirname(SCRIPT_PATH), "../../..");
const RESULT_PREFIX = "PURE_REPLAY_RESULT=";
const tsOnly = Bun.argv.includes("--ts-only");

function valueAfter(flag: string): string | undefined {
	const index = Bun.argv.indexOf(flag);
	return index === -1 ? undefined : Bun.argv[index + 1];
}

function fullCommit(ref: string): string {
	return execFileSync("git", ["rev-parse", `${ref}^{commit}`], {
		cwd: REPO_ROOT,
		encoding: "utf8",
	}).trim();
}

async function createReplayHarness() {
	const { RustTestHarness } = await import("../src/rust-harness");
	const options = {
		startInTsMode: true,
		startHistorianProducer: false,
		providerID: "anthropic",
		providerAPI: "@ai-sdk/anthropic",
		modelID: "mock-sonnet",
		modelContextLimit: 200_000,
		magicContextConfig: {
			execute_threshold_percentage: 90,
			memory: { auto_search: { enabled: false } },
			compressor: { enabled: false },
		},
	} as const;
	if (!tsOnly) return RustTestHarness.create(options);

	// TS comparisons need no native daemon. Keep the original provider route
	// and reuse the original capture methods, not a second wire serializer.
	process.env.MC_E2E_MODE = "ts";
	const { TestHarness } = await import("../src/harness");
	const harness = await TestHarness.create(options);
	try {
		const path = join(harness.opencode.env.configDir, "opencode.json");
		const config = JSON.parse(readFileSync(path, "utf8"));
		config.provider[options.providerID] = config.provider["mock-anthropic"];
		delete config.provider["mock-anthropic"];
		config.model = `${options.providerID}/${options.modelID}`;
		config.small_model = config.model;
		config.enabled_providers = [options.providerID];
		writeFileSync(path, JSON.stringify(config, null, 2));
		const canonicalConfig = join(
			harness.opencode.env.configDir,
			"cortexkit/magic-context.jsonc",
		);
		const userConfig = existsSync(canonicalConfig)
			? canonicalConfig
			: join(harness.opencode.env.configDir, "opencode/magic-context.jsonc");
		writeFileSync(
			userConfig,
			readFileSync(userConfig, "utf8").replaceAll(
				"mock-anthropic/mock-sonnet",
				`${options.providerID}/${options.modelID}`,
			),
		);
		const { createOpencodeClient } = await import("@opencode-ai/sdk");
		await createOpencodeClient({
			baseUrl: harness.opencode.url,
		}).instance.dispose({
			query: { directory: harness.opencode.env.workdir },
			throwOnError: true,
		});
		return {
			mock: harness.mock,
			createSession: () => harness.createSession(),
			contextDb: () => harness.contextDb(),
			sendPrompt: (sessionId: string, text: string) =>
				harness.sendPrompt(sessionId, text, options),
			dispose: () => harness.dispose(),
			mainRequests: RustTestHarness.prototype.mainRequests,
			lastMainWireSerialized: RustTestHarness.prototype.lastMainWireSerialized,
		};
	} catch (error) {
		await harness.dispose();
		throw error;
	}
}

async function captureCurrentCheckout(
	ref: string,
	commit: string,
): Promise<RefReplay> {
	const harness = await createReplayHarness();
	try {
		const sessionId = await harness.createSession();
		const db = harness.contextDb();
		const passes: ReplayPass[] = [];
		for (let index = 0; index < 4; index += 1) {
			harness.mock.setDefault({
				text: `[[pure-replay-${index}]]`,
				usage: { input_tokens: 1_000 + index, output_tokens: 10 },
			});
			await harness.sendPrompt(sessionId, `[[pure-replay-prompt-${index}]]`);
			const wire = harness.lastMainWireSerialized("messages");
			const decision = (
				db
					.prepare(
						"SELECT decision FROM transform_decisions WHERE session_id = ? ORDER BY ts_ms DESC LIMIT 1",
					)
					.get(sessionId) as { decision?: string } | null
			)?.decision;
			passes.push({
				pass: index + 1,
				decision: decision ?? null,
				bytes: Buffer.byteLength(wire),
				sha256: createHash("sha256").update(wire).digest("hex"),
			});
		}
		return { ref, commit, passes };
	} finally {
		await harness.dispose();
	}
}

function extractRef(
	ref: string,
	destination: string,
	sharedRoot: string,
): void {
	mkdirSync(destination, { recursive: true });
	const archive = execFileSync("git", ["archive", "--format=tar", ref], {
		cwd: REPO_ROOT,
		maxBuffer: 256 * 1024 * 1024,
	});
	execFileSync("tar", ["-xf", "-", "-C", destination], {
		input: archive,
		maxBuffer: 256 * 1024 * 1024,
	});

	for (const name of ["node_modules", "target"] as const) {
		const source = join(REPO_ROOT, name);
		if (existsSync(source)) symlinkSync(source, join(destination, name), "dir");
	}
	for (const packageName of [
		"e2e-tests",
		"plugin",
		"retina-local-fs",
	] as const) {
		const source = join(REPO_ROOT, "packages", packageName, "node_modules");
		if (existsSync(source)) {
			symlinkSync(
				source,
				join(destination, "packages", packageName, "node_modules"),
				"dir",
			);
		}
	}
	for (const name of ["commons", "subconscious"] as const) {
		const source = resolve(REPO_ROOT, "..", name);
		if (existsSync(source) && !existsSync(join(sharedRoot, name))) {
			symlinkSync(source, join(sharedRoot, name), "dir");
		}
	}

	// The instrument itself is held constant; only imported harness/plugin source
	// comes from the requested ref.
	copyFileSync(
		SCRIPT_PATH,
		join(destination, "packages/e2e-tests/scripts/pure-replay-differential.ts"),
	);
}

function captureRef(
	ref: string,
	slot: "left" | "right",
	sharedRoot: string,
): RefReplay {
	const destination = join(sharedRoot, slot);
	const commit = fullCommit(ref);
	extractRef(ref, destination, sharedRoot);
	const child = spawnSync(
		process.execPath,
		[
			"packages/e2e-tests/scripts/pure-replay-differential.ts",
			...(tsOnly ? ["--ts-only"] : []),
			"--single-ref",
			ref,
			"--single-commit",
			commit,
		],
		{ cwd: destination, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
	);
	if (child.status !== 0) {
		throw new Error(
			`pure replay failed for ${ref} (exit ${child.status ?? "signal"})\n${child.stdout}\n${child.stderr}`,
		);
	}
	const resultLine = child.stdout
		.split("\n")
		.find((line) => line.startsWith(RESULT_PREFIX));
	if (!resultLine)
		throw new Error(
			`pure replay for ${ref} emitted no result\n${child.stdout}`,
		);
	return JSON.parse(resultLine.slice(RESULT_PREFIX.length)) as RefReplay;
}

function printRef(result: RefReplay): void {
	console.log(`REF ${result.ref} ${result.commit}`);
	for (const pass of result.passes) {
		console.log(
			`PASS ${pass.pass} decision=${pass.decision ?? "unknown"} bytes=${pass.bytes} sha256=${pass.sha256}`,
		);
	}
}

function compare(left: RefReplay, right: RefReplay): boolean {
	let identical = true;
	for (
		let index = 0;
		index < Math.max(left.passes.length, right.passes.length);
		index += 1
	) {
		const leftPass = left.passes[index];
		const rightPass = right.passes[index];
		if (leftPass?.decision !== "defer" && rightPass?.decision !== "defer")
			continue;
		const same =
			leftPass?.decision === "defer" &&
			rightPass?.decision === "defer" &&
			leftPass.bytes === rightPass.bytes &&
			leftPass.sha256 === rightPass.sha256;
		identical &&= same;
		console.log(
			`DEFER PASS ${index + 1} ${same ? "IDENTICAL" : "DIVERGENT"} left_bytes=${leftPass?.bytes ?? "missing"} left_sha256=${leftPass?.sha256 ?? "missing"} right_bytes=${rightPass?.bytes ?? "missing"} right_sha256=${rightPass?.sha256 ?? "missing"}`,
		);
	}
	return identical;
}

const singleRef = valueAfter("--single-ref");
const singleCommit = valueAfter("--single-commit");
if (singleRef) {
	if (!singleCommit) throw new Error("--single-ref requires --single-commit");
	const result = await captureCurrentCheckout(singleRef, singleCommit);
	console.log(`${RESULT_PREFIX}${JSON.stringify(result)}`);
} else {
	const refs = Bun.argv
		.slice(2)
		.filter((argument) => !argument.startsWith("--"));
	if (refs.length !== 2) {
		console.error(
			"usage: bun pure-replay-differential.ts [--ts-only] <left-ref> <right-ref>",
		);
		process.exit(2);
	}
	const sharedRoot = mkdtempSync(join(REPO_ROOT, ".pure-replay-differential-"));
	try {
		const left = captureRef(refs[0], "left", sharedRoot);
		const right = captureRef(refs[1], "right", sharedRoot);
		printRef(left);
		printRef(right);
		const deferPasses = left.passes.filter(
			(pass) => pass.decision === "defer",
		).length;
		const identical = deferPasses > 0 && compare(left, right);
		console.log(
			`RESULT ${identical ? "IDENTICAL" : "DIVERGENT"} defer_passes=${deferPasses}`,
		);
		process.exitCode = identical ? 0 : 1;
	} finally {
		rmSync(sharedRoot, { recursive: true, force: true });
	}
}
