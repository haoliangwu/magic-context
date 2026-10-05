import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

type PackageManifest = {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
    optionalDependencies?: Record<string, string>;
    scripts?: Record<string, string>;
};

const REPO_ROOT = resolve(import.meta.dir, "../../../..");
const TRANSFORMERS = "@huggingface/transformers";
const ONNX_RUNTIME_NODE = "onnxruntime-node";
const ONNX_RUNTIME_WEB = "onnxruntime-web";
const SHARP = "sharp";
const PLUGIN_WORKSPACES = [
    ["packages/plugin", "@cortexkit/opencode-magic-context"],
    ["packages/pi-plugin", "@cortexkit/pi-magic-context"],
] as const;

function readManifest(workspace: string): PackageManifest {
    return JSON.parse(
        readFileSync(join(REPO_ROOT, workspace, "package.json"), "utf8"),
    ) as PackageManifest;
}

function workspaceLockBlock(lockfile: string, workspace: string): string {
    const start = lockfile.indexOf(`    "${workspace}": {`);
    expect(start).toBeGreaterThanOrEqual(0);
    const end = lockfile.indexOf("\n    },", start);
    expect(end).toBeGreaterThan(start);
    return lockfile.slice(start, end);
}

function directDependenciesLockBlock(workspaceLockBlock: string): string {
    const start = workspaceLockBlock.indexOf('"dependencies": {');
    expect(start).toBeGreaterThanOrEqual(0);
    const end = workspaceLockBlock.indexOf("\n      },", start);
    expect(end).toBeGreaterThan(start);
    return workspaceLockBlock.slice(start, end);
}

describe("native ONNX install shape", () => {
    test("bundles transformers and leaves only the native accelerator optional", () => {
        const lockfile = readFileSync(join(REPO_ROOT, "bun.lock"), "utf8");

        for (const [workspace, packageName] of PLUGIN_WORKSPACES) {
            const manifest = readManifest(workspace);
            expect(manifest.dependencies?.[TRANSFORMERS]).toBeUndefined();
            expect(manifest.dependencies?.[ONNX_RUNTIME_NODE]).toBeUndefined();
            expect(manifest.dependencies?.[SHARP]).toBeUndefined();
            expect(manifest.dependencies?.[ONNX_RUNTIME_WEB]).toBe(
                "1.26.0-dev.20260416-b7804b056c",
            );
            expect(manifest.devDependencies?.[TRANSFORMERS]).toBe("^4.3.0");
            expect(manifest.optionalDependencies?.[ONNX_RUNTIME_NODE]).toBe("1.30.0");
            expect(manifest.optionalDependencies?.[SHARP]).toBe("^0.35.0");
            expect(manifest.scripts?.build).toContain("transformers-web-entry.ts");
            expect(manifest.scripts?.build).toContain("build-transformers-node-wasm.ts");
            expect(manifest.scripts?.build).toContain("--target browser");
            expect(manifest.scripts?.build).not.toContain("--external @huggingface/transformers");
            expect(manifest.scripts?.build).toContain("--external onnxruntime-node");

            const lockBlock = workspaceLockBlock(lockfile, workspace);
            expect(lockBlock).toContain(`"name": "${packageName}"`);
            expect(directDependenciesLockBlock(lockBlock)).not.toContain(`"${TRANSFORMERS}":`);
            expect(directDependenciesLockBlock(lockBlock)).not.toContain(`"${ONNX_RUNTIME_NODE}":`);
            expect(directDependenciesLockBlock(lockBlock)).not.toContain(`"${SHARP}":`);
            expect(lockBlock).toContain(
                `"optionalDependencies": {\n        "${ONNX_RUNTIME_NODE}": "1.30.0",\n        "${SHARP}": "^0.35.0",`,
            );
        }
    });

    test("Node WASM twin preserves filesystem builtins while replacing optional native loaders", () => {
        const buildScript = readFileSync(
            join(REPO_ROOT, "packages/plugin/scripts/build-transformers-node-wasm.ts"),
            "utf8",
        );
        expect(buildScript).toContain('target: "node"');
        expect(buildScript).toContain("filter: /^onnxruntime-node$/");
        expect(buildScript).toContain("filter: /^sharp$/");
        expect(buildScript).toContain("src/transformers.js");
        expect(buildScript).not.toContain("filter: /^node:fs$/");
    });
});
