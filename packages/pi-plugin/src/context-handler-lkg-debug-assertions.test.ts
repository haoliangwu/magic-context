import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

test("Pi recovery accounting measures the restored served prefix before the last-writer assertion", () => {
	const result = spawnSync(
		process.execPath,
		[
			"test",
			"./src/context-handler-lkg.test.ts",
			"-t",
			"preserves complete busy recovery bytes on healthy passes",
			"--timeout",
			"60000",
		],
		{
			cwd: resolve(import.meta.dir, ".."),
			env: {
				...process.env,
				OPENCODE_DB: undefined,
				MAGIC_CONTEXT_DEBUG_ASSERTIONS: "1",
				BUN_JSC_useOMGJIT: "0",
			},
			encoding: "utf8",
			timeout: 90000,
			windowsHide: true,
		},
	);
	expect(result.status, result.stdout + result.stderr).toBe(0);
	expect(result.stderr).toContain(
		"(pass) Pi context handler LKG replay > preserves complete busy recovery bytes on healthy passes (prose and result)",
	);
	expect(result.stderr).toContain(
		"(pass) Pi context handler LKG replay > preserves complete busy recovery bytes on healthy passes (two results)",
	);
}, 120000);
