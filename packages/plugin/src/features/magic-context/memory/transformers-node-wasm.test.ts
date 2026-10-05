import { describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createTestTempDirFromPath } from "../../../shared/test-temp-dir";

const pluginRoot = resolve(import.meta.dir, "../../../..");

function run(cmd: string[]): { exitCode: number; stderr: string; stdout: string } {
    const result = Bun.spawnSync({
        windowsHide: true,
        cmd,
        cwd: pluginRoot,
        stdout: "pipe",
        stderr: "pipe",
    });
    return {
        exitCode: result.exitCode,
        stderr: result.stderr.toString(),
        stdout: result.stdout.toString(),
    };
}

describe("Node WASM Transformers fixture", () => {
    test("builds with real fs and persists a model for offline reuse", () => {
        const outputDir = createTestTempDirFromPath(join(tmpdir(), "mc-node-wasm-build-"));
        try {
            const build = run(["bun", "scripts/build-transformers-node-wasm.ts", outputDir]);
            expect(build.exitCode, build.stderr).toBe(0);

            const probe = run([
                "bun",
                "scripts/verify-transformers-node-wasm.ts",
                join(outputDir, "transformers-node-wasm.js"),
            ]);
            expect(probe.exitCode, probe.stderr).toBe(0);
            expect(probe.stdout).toContain("transformers-node-wasm filesystem cache probe passed");
        } finally {
            rmSync(outputDir, { recursive: true, force: true });
        }
    }, 30_000);
});
