import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const source = resolve(
	process.env.FENCE_REVIEW_SOURCE ?? resolve(import.meta.dir, "../../.."),
);

for (const seed of [2, 3, 8]) {
	test(`independent no-busy restart regression: Pi held seed ${seed}`, () => {
		const result = spawnSync(
			process.execPath,
			[
				"test",
				"packages/pi-plugin/src/issue-665-hold-review-r2.test.ts",
				"-t",
				`Pi held driver seed ${seed}:`,
				"--timeout",
				"120000",
			],
			{
				cwd: source,
				env: {
					...process.env,
					OPENCODE_DB: undefined,
					R2_SEEDS: String(seed),
					R2_PASSES: "150",
					BUN_JSC_useOMGJIT: "0",
				},
				encoding: "utf8",
				timeout: 180000,
				windowsHide: true,
			},
		);
		expect(result.stderr).toContain(`Pi held driver seed ${seed}:`);
		expect(result.status, result.stdout + result.stderr).toBe(0);
	}, 180000);
}
