import {
	copyFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// Run identical randomized Pi tests against archived master and this checkout.
// Both processes load bunfig's preload, which redirects configuration and database
// paths into temporary directories instead of using the operator's data.
const root = resolve(import.meta.dir, "../../../../..");
const report = resolve(
	process.argv[2] ??
		".cortexkit/internal-docs/investigations/issue-689-review-evidence",
);
const scratch = mkdtempSync(join(tmpdir(), "mc-review-689-diff-"));
const baseline = join(scratch, "master");
const driver = "packages/pi-plugin/src/issue-665-hold-review-r2.test.ts";
const seedList = process.env.R2_SEEDS ?? "689,665,650,7";
const passes = process.env.R2_PASSES ?? "150";

async function run(args: string[], cwd: string, env = process.env) {
	const child = Bun.spawn(args, { cwd, env, stdout: "pipe", stderr: "pipe" });
	const [stdout, stderr, code] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	return { code, output: stdout + stderr };
}

try {
	mkdirSync(report, { recursive: true });
	mkdirSync(baseline);
	const archive = join(scratch, "master.tar");
	for (const args of [
		[
			"git",
			"-c",
			`safe.directory=${root}`,
			"archive",
			"--format=tar",
			`--output=${archive}`,
			"cc654a68",
		],
		["tar", "-xf", archive, "-C", baseline],
	]) {
		const result = await run(args, root);
		if (result.code) throw new Error(result.output);
	}
	for (const path of [
		"node_modules",
		"packages/plugin/node_modules",
		"packages/pi-plugin/node_modules",
	])
		if (existsSync(join(root, path)))
			symlinkSync(join(root, path), join(baseline, path), "dir");
	copyFileSync(join(root, driver), join(baseline, driver));
	const outcomes = [];
	for (const [label, tree] of [
		["master", baseline],
		["delivery", root],
	] as const) {
		const env = {
			...process.env,
			OPENCODE_DB: undefined,
			BUN_JSC_useOMGJIT: "0",
			R2_SEEDS: seedList,
			R2_PASSES: passes,
			R2_WINDOW: "10000000",
			R2_LITERAL: "1",
			R2_HEADLESS: "1",
			R2_TRACE: join(report, label),
		};
		// Trace files append, so a rerun must not inherit a previous comparison.
		for (const file of readdirSync(report))
			if (file.startsWith(`${label}.pi-`)) rmSync(join(report, file));
		const result = await run(
			[
				process.execPath,
				"test",
				"src/issue-665-hold-review-r2.test.ts",
				"--parallel=1",
				"--timeout",
				"600000",
			],
			join(tree, "packages/pi-plugin"),
			env,
		);
		writeFileSync(join(report, `${label}-tests.txt`), result.output);
		outcomes.push({ label, exit: result.code });
	}
	type Row = {
		pass: number;
		events: string[];
		decision: string;
		wireHash: string;
		tags: string;
		pair: string;
		refused: string | null;
		rawInputBytes: number;
	};
	let compared = 0;
	let executes = 0;
	let defers = 0;
	let folds = 0;
	let restarts = 0;
	let maxRawInputBytes = 0;
	const differences: unknown[] = [];
	for (const file of readdirSync(report).filter((file) =>
		file.startsWith("master.pi-"),
	)) {
		const rows = (name: string): Row[] =>
			readFileSync(join(report, name), "utf8")
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line));
		const before = rows(file);
		const after = rows(file.replace("master.", "delivery."));
		if (before.length !== after.length)
			throw new Error(`trace length differs: ${file}`);
		for (let index = 0; index < before.length; index++) {
			const a = before[index];
			const b = after[index];
			if (!a || !b || !a.wireHash || !b.wireHash)
				throw new Error("missing literal trace");
			compared++;
			executes += Number(b.decision === "execute");
			defers += Number(b.decision === "defer");
			folds += Number(b.events.includes("compartment"));
			restarts += Number(b.events.includes("restart"));
			maxRawInputBytes = Math.max(maxRawInputBytes, b.rawInputBytes);
			for (const key of [
				"wireHash",
				"tags",
				"pair",
				"refused",
				"decision",
			] as const)
				if (a[key] !== b[key])
					differences.push({
						file,
						pass: a.pass,
						field: key,
						master: a[key],
						delivery: b[key],
						events: b.events,
					});
		}
	}
	const summary = {
		bun: Bun.version,
		baseline: "cc654a68",
		seedList,
		passesPerScenario: Number(passes),
		outcomes,
		compared,
		executes,
		defers,
		folds,
		restarts,
		maxRawInputBytes,
		contextWindow: 10000000,
		differenceCount: differences.length,
		differences,
	};
	writeFileSync(
		join(report, "differential-summary.json"),
		`${JSON.stringify(summary, null, 2)}\n`,
	);
	console.log(
		JSON.stringify(
			{ ...summary, differences: differences.slice(0, 10) },
			null,
			2,
		),
	);
	console.log(
		`literal-served-byte-differential: ${!compared || differences.length || outcomes.some((result) => result.exit) ? "FAIL" : "PASS"} (${compared} passes, ${differences.length} differences)`,
	);
	if (!compared || differences.length || outcomes.some((result) => result.exit))
		process.exitCode = 1;
} finally {
	rmSync(scratch, { recursive: true, force: true });
}
