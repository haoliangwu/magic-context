#!/usr/bin/env bun
import {
	copyFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	statSync,
	symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { printGrowthTable, printLargestPhaseTable } from "./reporting";
import type { PerfRunReport } from "./run";

interface Options {
	interleave?: boolean;
	settledUsage?: boolean;
	lane?: string;
	reportDir?: string;
	contextWindow?: number;
	fixture?: string;
	baseline: string;
	messages: number;
	step: number;
	points?: string;
	repeatFinal: number;
}

async function main(): Promise<void> {
	const options = parseOptions(process.argv.slice(2));
	if (options.fixture && statSync(options.fixture).isDirectory()) {
		const fixtures = Array.from(
			new Bun.Glob("**/*.jsonl").scanSync({
				cwd: options.fixture,
				absolute: true,
			}),
		).sort();
		if (fixtures.length === 0) {
			throw new Error(`No JSONL fixtures under ${options.fixture}`);
		}
		const fixtureArgIndex = process.argv.indexOf("--fixture") + 1;
		for (const fixture of fixtures) {
			const childArgs = process.argv.slice(2);
			childArgs[fixtureArgIndex - 2] = fixture;
			await run(
				[process.execPath, process.argv[1] ?? "compare.ts", ...childArgs],
				process.cwd(),
			);
		}
		console.log(
			`\nfixture corpus identity: ${fixtures.length} files, all comparisons passed`,
		);
		return;
	}
	const repoRoot = await commandOutput(
		["git", "rev-parse", "--show-toplevel"],
		process.cwd(),
	);
	if (options.baseline === "AUTO") {
		const history = await commandOutput(
			[
				"git",
				"log",
				"--reverse",
				"--format=%H",
				"--",
				"packages/pi-plugin/scripts/experiments/perf/compare.ts",
			],
			repoRoot,
		);
		options.baseline = history.split("\n")[0] || "HEAD^";
	}
	const tempRoot = mkdtempSync(join(tmpdir(), "mc-pi-perf-compare-"));
	const baselineRoot = join(tempRoot, "baseline");
	const archive = join(tempRoot, "baseline.tar");
	const baselineReportPath = join(tempRoot, "baseline.json");
	const optimizedReportPath = join(tempRoot, "optimized.json");

	try {
		await run(
			[
				"git",
				"cat-file",
				"-e",
				`${options.baseline}:packages/pi-plugin/scripts/experiments/perf/run.ts`,
			],
			repoRoot,
		);
		await run(
			[
				"git",
				"archive",
				"--format=tar",
				`--output=${archive}`,
				options.baseline,
			],
			repoRoot,
		);
		mkdirSync(baselineRoot, { recursive: true });
		await run(["tar", "-xf", archive, "-C", baselineRoot], repoRoot);
		linkDependencies(repoRoot, baselineRoot);
		// Both revisions use the same measurement driver; only product modules
		// come from the archive, keeping the measurement procedure identical.
		copyFileSync(
			join(repoRoot, "packages/pi-plugin/scripts/experiments/perf/run.ts"),
			join(baselineRoot, "packages/pi-plugin/scripts/experiments/perf/run.ts"),
		);

		const commonArgs = [
			"--messages",
			String(options.messages),
			"--step",
			String(options.step),
		];
		if (options.repeatFinal > 0) {
			commonArgs.push("--repeat-final", String(options.repeatFinal));
		}
		if (options.fixture) commonArgs.push("--fixture", resolve(options.fixture));
		if (options.points) commonArgs.push("--points", options.points);
		if (options.settledUsage) commonArgs.push("--settled-usage");
		if (options.lane) commonArgs.push("--lane", options.lane);
		if (options.contextWindow)
			commonArgs.push("--context-window", String(options.contextWindow));

		const beforeArgs = [...commonArgs, "--output", baselineReportPath];
		const afterArgs = [...commonArgs, "--output", optimizedReportPath];
		if (options.interleave)
			await runInterleaved(baselineRoot, beforeArgs, repoRoot, afterArgs);
		else {
			await runRunner(baselineRoot, beforeArgs);
			await runRunner(repoRoot, afterArgs);
		}

		const baseline = (await Bun.file(
			baselineReportPath,
		).json()) as PerfRunReport;
		const optimized = (await Bun.file(
			optimizedReportPath,
		).json()) as PerfRunReport;
		assertIdentical(baseline, optimized);
		if (options.reportDir) {
			mkdirSync(resolve(options.reportDir), { recursive: true });
			copyFileSync(
				baselineReportPath,
				join(resolve(options.reportDir), "baseline.json"),
			);
			copyFileSync(
				optimizedReportPath,
				join(resolve(options.reportDir), "optimized.json"),
			);
		}
		if (options.repeatFinal > 0) {
			for (const [label, report] of [
				["baseline", baseline],
				["optimized", optimized],
			] as const) {
				const repeats = report.passes.slice(-options.repeatFinal);
				const times = repeats
					.map((pass) => pass.handlerMs)
					.sort((a, b) => a - b);
				const quantile = (q: number) => {
					const index = q * (times.length - 1);
					const low = Math.floor(index),
						high = Math.ceil(index);
					return (
						(times[low] ?? 0) +
						((times[high] ?? 0) - (times[low] ?? 0)) * (index - low)
					);
				};
				console.log(
					`${label}: ${times.length} warm handler passes p50=${quantile(0.5).toFixed(3)}ms p95=${quantile(0.95).toFixed(3)}ms p99=${quantile(0.99).toFixed(3)}ms full-array-clones=${repeats.reduce((sum, pass) => sum + pass.fullArrayClones, 0)} defer=${repeats.filter((pass) => pass.decision === "defer").length} envelope-reads=${repeats.reduce((sum, pass) => sum + pass.fitEnvelopeReads, 0)}`,
				);
			}
		}
		printGrowthTable(`baseline (${options.baseline})`, baseline);
		printGrowthTable("optimized", optimized);
		printLargestPhaseTable(`baseline (${options.baseline})`, baseline);
		printLargestPhaseTable("optimized", optimized);

		const before = baseline.passes.at(-1)?.handlerMs ?? 0;
		const after = optimized.passes.at(-1)?.handlerMs ?? 0;
		const speedup = after > 0 ? before / after : Number.POSITIVE_INFINITY;
		console.log(
			`\nbyte identity: ${optimized.passes.length} passes, zero output diffs, ` +
				`zero persisted-tag diffs`,
		);
		console.log(
			`headline: ${before.toFixed(1)}ms -> ${after.toFixed(1)}ms ` +
				`(${speedup.toFixed(2)}x at ${optimized.passes.at(-1)?.inputMessages ?? 0} messages)`,
		);
	} finally {
		rmSync(tempRoot, { recursive: true, force: true });
	}
}

function assertIdentical(
	baseline: PerfRunReport,
	optimized: PerfRunReport,
): void {
	if (baseline.fixture !== optimized.fixture) {
		throw new Error(
			`Fixture mismatch: ${baseline.fixture} != ${optimized.fixture}`,
		);
	}
	if (baseline.passes.length !== optimized.passes.length) {
		throw new Error(
			`Pass-count mismatch: ${baseline.passes.length} != ${optimized.passes.length}`,
		);
	}
	for (let index = 0; index < baseline.passes.length; index += 1) {
		const before = baseline.passes[index];
		const after = optimized.passes[index];
		if (!before || !after)
			throw new Error(`Missing report at pass ${index + 1}`);
		if (before.requestedMessages !== after.requestedMessages) {
			throw new Error(
				`Pass ${index + 1} accumulation mismatch: ` +
					`${before.requestedMessages} != ${after.requestedMessages}`,
			);
		}
		if (
			before.outputHash !== after.outputHash ||
			before.wireHash !== after.wireHash ||
			before.outputBytes !== after.outputBytes
		) {
			throw new Error(
				`Pass ${index + 1} output differs at ${before.inputMessages} messages: ` +
					`${before.outputHash} != ${after.outputHash}`,
			);
		}
		if (
			before.tagRowsHash !== after.tagRowsHash ||
			before.tagRows !== after.tagRows
		) {
			throw new Error(
				`Pass ${index + 1} persisted tags differ at ${before.inputMessages} messages: ` +
					`${before.tagRowsHash} != ${after.tagRowsHash}`,
			);
		}
	}
}

async function runRunner(root: string, args: string[]): Promise<void> {
	await run(
		[
			process.execPath,
			join(root, "packages/pi-plugin/scripts/experiments/perf/run.ts"),
			...args,
		],
		join(root, "packages/pi-plugin"),
		{ ...process.env, NODE_ENV: "test" },
	);
}

async function runInterleaved(
	beforeRoot: string,
	beforeArgs: string[],
	afterRoot: string,
	afterArgs: string[],
): Promise<void> {
	const start = (root: string, args: string[]) => {
		const home = mkdtempSync(join(tmpdir(), "pi-perf-runner-"));
		const env: Record<string, string | undefined> = {
			...process.env,
			NODE_ENV: "test",
			HOME: home,
		};
		env.MAGIC_CONTEXT_LOG_PATH = join(home, "magic-context.log");
		for (const key of [
			"TMPDIR",
			"XDG_CONFIG_HOME",
			"XDG_DATA_HOME",
			"XDG_STATE_HOME",
			"XDG_CACHE_HOME",
			"XDG_RUNTIME_DIR",
			"MAGIC_CONTEXT_STORAGE_DIR",
			"PI_CODING_AGENT_DIR",
		] as const) {
			const path = join(home, key);
			env[key] = path;
			mkdirSync(path, { recursive: true });
		}
		const child = Bun.spawn(
			[
				process.execPath,
				join(root, "packages/pi-plugin/scripts/experiments/perf/run.ts"),
				...args,
				"--stepwise",
			],
			{
				cwd: join(root, "packages/pi-plugin"),
				env,
				stdin: "pipe",
				stdout: "pipe",
				stderr: "inherit",
			},
		);
		const lines = (async function* () {
			let text = "";
			for await (const chunk of child.stdout) {
				text += Buffer.from(chunk).toString();
				let end = text.indexOf("\n");
				while (end >= 0) {
					yield text.slice(0, end);
					text = text.slice(end + 1);
					end = text.indexOf("\n");
				}
			}
		})();
		const until = async (marker: string) => {
			for (;;) {
				const line = await lines.next();
				if (line.done) {
					const code = await child.exited;
					if (code !== 0 || marker !== "PERF_READY")
						throw new Error(
							`Stepwise runner stopped before ${marker} (exit ${code})`,
						);
					return false;
				}
				if (line.value === marker) return true;
			}
		};
		return { child, until, home };
	};
	const before = start(beforeRoot, beforeArgs);
	const after = start(afterRoot, afterArgs);
	try {
		for (let pass = 0; ; pass++) {
			const ready = await Promise.all([
				before.until("PERF_READY"),
				after.until("PERF_READY"),
			]);
			if (!ready[0] && !ready[1]) break;
			if (!ready[0] || !ready[1])
				throw new Error("Interleaved pass-count mismatch");
			// Alternating AB/BA pairs reduce drift; no two handlers run together.
			for (const runner of pass % 2 ? [after, before] : [before, after]) {
				runner.child.stdin.write("next\n");
				await runner.child.stdin.flush();
				await runner.until("PERF_DONE");
			}
		}
	} finally {
		before.child.kill();
		after.child.kill();
		await Promise.all([before.child.exited, after.child.exited]);
		rmSync(before.home, { recursive: true, force: true });
		rmSync(after.home, { recursive: true, force: true });
	}
}

function linkDependencies(repoRoot: string, baselineRoot: string): void {
	const links = [
		[join(repoRoot, "node_modules"), join(baselineRoot, "node_modules")],
		[
			join(repoRoot, "packages/pi-plugin/node_modules"),
			join(baselineRoot, "packages/pi-plugin/node_modules"),
		],
		[
			join(repoRoot, "packages/plugin/node_modules"),
			join(baselineRoot, "packages/plugin/node_modules"),
		],
	];
	for (const [source, target] of links) {
		if (!source || !target || !existsSync(source)) continue;
		mkdirSync(dirname(target), { recursive: true });
		symlinkSync(source, target, "dir");
	}
}

async function commandOutput(command: string[], cwd: string): Promise<string> {
	const child = Bun.spawn(command, { cwd, stdout: "pipe", stderr: "inherit" });
	const output = await new Response(child.stdout).text();
	const exitCode = await child.exited;
	if (exitCode !== 0)
		throw new Error(`${command.join(" ")} exited with status ${exitCode}`);
	return output.trim();
}

async function run(
	command: string[],
	cwd: string,
	env: Record<string, string | undefined> = process.env,
): Promise<void> {
	const child = Bun.spawn(command, {
		cwd,
		env,
		stdout: "inherit",
		stderr: "inherit",
	});
	const exitCode = await child.exited;
	if (exitCode !== 0)
		throw new Error(`${command.join(" ")} exited with status ${exitCode}`);
}

function parseOptions(args: readonly string[]): Options {
	const options: Options = {
		baseline: "AUTO",
		messages: 1_000,
		step: 500,
		repeatFinal: 0,
	};
	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index];
		const value = args[index + 1];
		if (arg === "--interleave") {
			options.interleave = true;
		} else if (arg === "--settled-usage") {
			options.settledUsage = true;
		} else if (arg === "--lane" && value) {
			options.lane = value;
			index++;
		} else if (arg === "--report-dir" && value) {
			options.reportDir = value;
			index++;
		} else if (arg === "--context-window" && value) {
			options.contextWindow = positiveInteger(value, arg);
			index++;
		} else if (arg === "--fixture" && value) {
			options.fixture = value;
			index += 1;
		} else if (arg === "--baseline" && value) {
			options.baseline = value;
			index += 1;
		} else if (arg === "--messages" && value) {
			options.messages = positiveInteger(value, arg);
			index += 1;
		} else if (arg === "--step" && value) {
			options.step = positiveInteger(value, arg);
			index += 1;
		} else if (arg === "--points" && value) {
			options.points = value;
			index += 1;
		} else if (arg === "--repeat-final" && value) {
			options.repeatFinal = positiveInteger(value, arg);
			index += 1;
		} else {
			throw new Error(`Unknown or incomplete argument: ${arg ?? "<missing>"}`);
		}
	}
	return options;
}

function positiveInteger(value: string, option: string): number {
	const parsed = Number.parseInt(value, 10);
	if (!Number.isSafeInteger(parsed) || parsed <= 0) {
		throw new Error(`${option} requires a positive integer, got ${value}`);
	}
	return parsed;
}

await main();
