import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const candidate = resolve(import.meta.dir, "..");
const base = process.env.FENCE_REVIEW_BASE;
const output = process.env.FENCE_REVIEW_OUTPUT;
if (!base || !output)
	throw new Error("FENCE_REVIEW_BASE and FENCE_REVIEW_OUTPUT are required");
const fixture = "packages/pi-plugin/src/lkg-fence-independent.test.ts";
copyFileSync(join(candidate, fixture), join(base, fixture));
const results: unknown[] = [];
let comparisons = 0;
for (const seed of [81273, 177013, 991021]) {
	for (const host of ["pi", "oc1", "oc2"]) {
		const revisions: Array<[string, string]> =
			seed === 177013
				? [
						["candidate", candidate],
						["base", base],
					]
				: [
						["base", base],
						["candidate", candidate],
					];
		for (const [label, source] of revisions) {
			const root = join(output, label, host, String(seed));
			mkdirSync(root, { recursive: true });
			const result = spawnSync(
				process.execPath,
				["test", fixture, "--timeout", "120000"],
				{
					cwd: source,
					env: {
						...process.env,
						OPENCODE_DB: undefined,
						FENCE_REVIEW_SOURCE: source,
						FENCE_REVIEW_OUTPUT: root,
						FENCE_REVIEW_CWD: candidate,
						FENCE_REVIEW_HOST: host,
						FENCE_REVIEW_SEED: String(seed),
						XDG_DATA_HOME: join(root, "data"),
						XDG_CONFIG_HOME: join(root, "config"),
						MAGIC_CONTEXT_STORAGE_DIR: join(root, "store"),
						MAGIC_CONTEXT_TEST_DATA_DIR: join(root, "test"),
						BUN_JSC_useOMGJIT: "0",
					},
					encoding: "utf8",
					timeout: 180000,
					windowsHide: true,
				},
			);
			console.log(
				`${label}/${host}/${seed}\n${result.stdout}\n${result.stderr}`,
			);
			assert.equal(result.status, 0, `${label}/${host}/${seed}: child failed`);
			const stats = result.stdout
				.split("\n")
				.find((line) => line.startsWith("INDEPENDENT "));
			assert.ok(stats, "No measurement emitted");
			results.push({ label, ...JSON.parse(stats.slice(12)) });
		}
		const a = JSON.parse(
			readFileSync(
				join(output, "base", host, String(seed), `${host}-${seed}.json`),
				"utf8",
			),
		) as string[];
		const b = JSON.parse(
			readFileSync(
				join(output, "candidate", host, String(seed), `${host}-${seed}.json`),
				"utf8",
			),
		) as string[];
		assert.equal(a.length, 120);
		assert.equal(b.length, 120);
		for (let i = 0; i < a.length; i++) {
			const baseWire = a[i];
			const candidateWire = b[i];
			assert.equal(typeof baseWire, "string");
			assert.equal(typeof candidateWire, "string");
			if (baseWire !== candidateWire) {
				writeFileSync(
					join(output, "difference.json"),
					JSON.stringify(
						{
							host,
							seed,
							pass: i,
							base: JSON.parse(baseWire),
							candidate: JSON.parse(candidateWire),
						},
						null,
						2,
					),
				);
				throw new Error(
					`COMPLETE REQUEST DIFFERENCE host=${host} seed=${seed} pass=${i}; witness ${output}/difference.json`,
				);
			}
			comparisons++;
		}
		console.log(
			`COMPLETE_EQUAL host=${host} seed=${seed} requests=${a.length}`,
		);
	}
}
writeFileSync(
	join(output, "summary.json"),
	JSON.stringify({ comparisons, results }, null, 2),
);
console.log(`COMPLETE_EQUAL total=${comparisons} hosts=3 seeds=3`);
