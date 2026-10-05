/**
 * Regenerate the pre-fix served-array fixture used by issue-485-replay-gate.test.ts.
 *
 * The gate asserts that the Pi context handler still serves byte-identical message
 * arrays for a no-system transcript after the issue 485 rework. The comparison
 * baseline is the package source as it stood immediately before that rework
 * landed, which only a git checkout can produce — so it is produced HERE, once,
 * by a script a developer runs by hand, and committed as bytes. The test itself
 * never touches git: a shallow CI checkout has no history to reach, and a test
 * that reads repository history is unreproducible anywhere the history differs.
 *
 * Run from the repository root:
 *     bun packages/pi-plugin/scripts/generate-issue-485-pre-fix-fixture.ts
 *
 * It prints the SHA-256 of the fixture bytes. Paste that into
 * PRE_FIX_FIXTURE_SHA256 in issue-485-replay-gate.test.ts — the pin is what makes
 * a silent edit of the recorded baseline impossible: changing the fixture without
 * also changing the pin turns the gate red.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	copyFileSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";

// The commit before the issue 485 merge (60360073, the #474 tie-break merge):
// the last revision whose Pi lane predates every system-message change the gate
// is guarding.
const BASELINE_REF = process.argv[2] ?? "60360073^1";

const root = resolve(import.meta.dir, "../../..");
const driver = resolve(import.meta.dir, "../src/issue-485-replay-gate.test.ts");
const fixturePath = resolve(
	import.meta.dir,
	"../src/fixtures/issue-485-pre-fix-served-arrays.json",
);

const baselineCommit = execFileSync(
	"git",
	["rev-parse", `${BASELINE_REF}^{commit}`],
	{
		cwd: root,
		encoding: "utf8",
	},
).trim();
const baselineSubject = execFileSync(
	"git",
	["log", "-1", "--format=%s", baselineCommit],
	{ cwd: root, encoding: "utf8" },
).trim();

const temp = mkdtempSync(join(root, ".issue-485-pure-"));
try {
	// Lay the baseline package out as a working tree: archived sources, with the
	// installed dependencies and the sibling workspace packages linked in from the
	// current checkout so only packages/pi-plugin differs from today's source.
	const archive = execFileSync(
		"git",
		["archive", baselineCommit, "packages/pi-plugin"],
		{
			cwd: root,
			maxBuffer: 100 * 1024 * 1024,
		},
	);
	execFileSync("tar", ["-xf", "-", "-C", temp], { input: archive });
	symlinkSync(join(root, "node_modules"), join(temp, "node_modules"), "dir");
	for (const pkg of ["plugin", "retina-local-fs"])
		symlinkSync(
			join(root, "packages", pkg),
			join(temp, "packages", pkg),
			"dir",
		);
	symlinkSync(
		join(root, "packages/pi-plugin/node_modules"),
		join(temp, "packages/pi-plugin/node_modules"),
		"dir",
	);

	// The replay driver ("F pure replay child") is copied in from today's tree so
	// both sides run the SAME scenario; the only thing that varies is the Pi lane
	// source it exercises.
	const script = join(
		temp,
		"packages/pi-plugin/src/issue-485-replay-gate.test.ts",
	);
	copyFileSync(driver, script);

	// An empty directory as the session cwd: no git repository, no project files,
	// so the replay cannot pick up anything from the machine it runs on.
	const empty = join(temp, "empty");
	mkdirSync(empty);

	const child = Bun.spawnSync(
		[process.execPath, "test", script, "-t", "F pure replay child"],
		{
			cwd: dirname(script),
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
	const passes: unknown[] = JSON.parse(line.slice("PURE_GATE=".length));

	const contents = `${JSON.stringify(
		{
			baselineRef: BASELINE_REF,
			baselineCommit,
			baselineSubject,
			generatedBy:
				"packages/pi-plugin/scripts/generate-issue-485-pre-fix-fixture.ts",
			passes,
		},
		null,
		"\t",
	)}\n`;
	writeFileSync(fixturePath, contents);
	const digest = createHash("sha256").update(contents, "utf8").digest("hex");
	console.log(
		`Recorded ${passes.length} pre-fix replay passes from ${baselineCommit}`,
	);
	console.log(`PRE_FIX_FIXTURE_SHA256 = "${digest}"`);
} finally {
	rmSync(temp, { recursive: true, force: true });
}
