import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { LOCAL_EMBEDDING_RUNTIME_FINGERPRINT } from "./embedding-identity";

// The fingerprint fences stored local vectors to the runtime stack that produced
// them, so it must move whenever the declared runtime versions move. A hand-kept
// constant would otherwise drift silently and let two vector spaces share one
// identity. This test reads the versions from the package manifests that npm
// resolves, so a dependency bump without a fingerprint bump fails here.

function declaredVersions(packageDir: string): {
    transformers: string;
    onnxNode: string;
    onnxWeb: string;
} {
    const manifest = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8")) as {
        dependencies?: Record<string, string>;
        optionalDependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
    };
    const all = {
        ...manifest.devDependencies,
        ...manifest.dependencies,
        ...manifest.optionalDependencies,
    };
    const exact = (spec: string | undefined, name: string): string => {
        if (!spec) throw new Error(`${name} is not declared in ${packageDir}/package.json`);
        return spec.replace(/^[\^~]/, "");
    };
    return {
        transformers: exact(all["@huggingface/transformers"], "@huggingface/transformers"),
        onnxNode: exact(all["onnxruntime-node"], "onnxruntime-node"),
        onnxWeb: exact(all["onnxruntime-web"], "onnxruntime-web"),
    };
}

describe("LOCAL_EMBEDDING_RUNTIME_FINGERPRINT", () => {
    const pluginDir = join(import.meta.dir, "..", "..", "..", "..");
    const piPluginDir = join(pluginDir, "..", "pi-plugin");

    it("matches the runtime versions declared by the plugin package", () => {
        const v = declaredVersions(pluginDir);
        expect(LOCAL_EMBEDDING_RUNTIME_FINGERPRINT).toBe(
            `transformers@${v.transformers};onnxruntime-node@${v.onnxNode};onnxruntime-web@${v.onnxWeb}`,
        );
    });

    it("matches the runtime versions declared by the Pi plugin package", () => {
        const v = declaredVersions(piPluginDir);
        expect(LOCAL_EMBEDDING_RUNTIME_FINGERPRINT).toBe(
            `transformers@${v.transformers};onnxruntime-node@${v.onnxNode};onnxruntime-web@${v.onnxWeb}`,
        );
    });
});
