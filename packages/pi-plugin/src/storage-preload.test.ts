import { expect, test } from "bun:test";
import path from "node:path";

test("Pi preload isolates storage and user config", () => {
	const testDataDir = process.env.MAGIC_CONTEXT_TEST_DATA_DIR;
	expect(testDataDir).toBeTruthy();
	expect(process.env.XDG_CONFIG_HOME).toBe(testDataDir);
	const resolverPath = path.resolve(
		import.meta.dir,
		"../../plugin/src/shared/data-path.ts",
	);
	const script = `const { getMagicContextStorageResolution } = await import(${JSON.stringify(
		resolverPath,
	)}); process.stdout.write(JSON.stringify(getMagicContextStorageResolution()));`;
	const completed = Bun.spawnSync([process.execPath, "-e", script], {
		env: {
			...process.env,
			MAGIC_CONTEXT_TEST_DATA_DIR: testDataDir as string,
			MAGIC_CONTEXT_STORAGE_DIR: "/tmp/magic-context-production-override",
		},
		windowsHide: true,
	});

	expect(completed.exitCode).toBe(0);
	expect(JSON.parse(completed.stdout.toString())).toEqual({
		path: path.join(testDataDir as string, "cortexkit", "magic-context"),
		source: "test isolation",
	});
});
