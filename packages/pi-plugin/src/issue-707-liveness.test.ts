import { expect, test } from "bun:test";
import { readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestTempDirFromPath } from "../../plugin/src/shared/test-temp-dir";

for (const runtime of ["Node", "Bun"] as const) {
	test(`superseded Pi inputs are collectable with a live embedding worker and stale write fence (${runtime})`, async () => {
		const directory = createTestTempDirFromPath(
			join(tmpdir(), "pi-worker-liveness-"),
		);
		try {
			await symlink(
				join(import.meta.dir, "../node_modules"),
				join(directory, "node_modules"),
				"dir",
			);
			const entry = join(directory, "runner.mjs");
			const build = await Bun.build({
				entrypoints: [
					new URL("__tests__/issue-707-liveness-runner.mjs", import.meta.url)
						.pathname,
				],
				target: "node",
				format: "esm",
				external: [
					"bun:sqlite",
					"bun:ffi",
					"onnxruntime-node",
					"onnxruntime-web",
					"sharp",
				],
				plugins: [
					{
						name: "observe-real-pass",
						setup(build) {
							build.onLoad(
								{ filter: /context-handler\.ts$/ },
								async ({ path }) => {
									const source = await readFile(path, "utf8");
									const marker =
										"// Empty host history has neither new identities nor an input prefix to publish.";
									expect(source.split(marker)).toHaveLength(2);
									return {
										loader: "ts",
										contents: source.replace(
											marker,
											`await globalThis.__observePass(lkgPassSnapshot, event.messages);\n${marker}`,
										),
									};
								},
							);
							build.onLoad(
								{ filter: /shared\/sqlite\.ts$/ },
								async ({ path }) => ({
									loader: "ts",
									contents: `${await readFile(path, "utf8")}\nglobalThis.__readLease = () => transformPassScope.getStore();`,
								}),
							);
						},
					},
				],
			});
			expect(build.success, build.logs.join("\n")).toBe(true);
			await writeFile(entry, await build.outputs[0].text());
			await writeFile(
				join(directory, "worker.mjs"),
				`import { parentPort } from 'node:worker_threads';
parentPort.on('message', ({id}) => parentPort.postMessage({id, loaded:true, vectors:[]}));`,
			);
			const child = Bun.spawn(
				[
					...(runtime === "Node"
						? ["node", "--expose-gc"]
						: [process.execPath]),
					entry,
				],
				{
					stdout: "pipe",
					stderr: "pipe",
					windowsHide: true,
					env: {
						...process.env,
						MAGIC_CONTEXT_STORAGE_DIR: directory,
						XDG_CONFIG_HOME: directory,
						XDG_DATA_HOME: directory,
						HOME: directory,
					},
				},
			);
			const [stdout, stderr, exit] = await Promise.all([
				new Response(child.stdout).text(),
				new Response(child.stderr).text(),
				child.exited,
			]);
			console.log(`${runtime}: ${stdout.trim()}`);
			expect(exit, stderr).toBe(0);
			expect(JSON.parse(stdout)).toMatchObject({
				passes: 2,
				staleWriteRejected: true,
				retainedSnapshots: 0,
				retainedInputs: 0,
				workerInheritedPass: false,
			});
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	}, 30_000);
}
