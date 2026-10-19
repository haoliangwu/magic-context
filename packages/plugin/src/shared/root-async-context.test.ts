import { expect, test } from "bun:test";
import { rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestTempDirFromPath } from "./test-temp-dir";

for (const runtime of ["Node", "Bun"] as const) {
    test(`root resources do not inherit request stores (${runtime})`, async () => {
        const directory = createTestTempDirFromPath(join(tmpdir(), "root-context-"));
        try {
            const entry = join(directory, "probe.mjs");
            const build = await Bun.build({
                entrypoints: [new URL("root-async-context.probe.mjs", import.meta.url).pathname],
                target: "node",
                format: "esm",
                external: ["bun:sqlite", "node:sqlite"],
            });
            expect(build.success).toBe(true);
            await writeFile(entry, await build.outputs[0].text());
            await writeFile(
                join(directory, "worker.mjs"),
                `import { parentPort } from 'node:worker_threads'; parentPort.on('message', () => {});`,
            );
            const child = Bun.spawn(
                [...(runtime === "Node" ? ["node", "--expose-gc"] : [process.execPath]), entry],
                {
                    stdout: "pipe",
                    stderr: "pipe",
                    windowsHide: true,
                },
            );
            const [stdout, stderr, exit] = await Promise.all([
                new Response(child.stdout).text(),
                new Response(child.stderr).text(),
                child.exited,
            ]);
            expect(exit, stderr).toBe(0);
            const result = JSON.parse(stdout);
            console.log(`${runtime} ALS propagation: ${stdout.trim()}`);
            expect(result.timerStores).toEqual({ ambient: true, root: false });
            expect(result.retained.rootWorker).toBe(0);
            expect(result.retained.rootTimer).toBe(0);
            expect(result.retained.ambientTimer).toBe(1);
            if (runtime === "Node") expect(result.retained.ambientWorker).toBe(1);
        } finally {
            await rm(directory, { recursive: true, force: true });
        }
    });
}
