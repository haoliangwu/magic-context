import { expect, it } from "bun:test";
import { existsSync, rmSync } from "node:fs";
import { cleanupE2ETempDir, createE2ETempDir } from "./temp-dir";

it("removes e2e fixtures by default and retains them only on explicit request", () => {
    const previous = process.env.MC_E2E_KEEP;
    const root = createE2ETempDir("mc-e2e-cleanup-test-");
    const retained = createE2ETempDir("mc-e2e-keep-test-");
    try {
        delete process.env.MC_E2E_KEEP;
        cleanupE2ETempDir(root);
        expect(existsSync(root)).toBe(false);
        process.env.MC_E2E_KEEP = "1";
        cleanupE2ETempDir(retained);
        expect(existsSync(retained)).toBe(true);
    } finally {
        if (previous === undefined) delete process.env.MC_E2E_KEEP;
        else process.env.MC_E2E_KEEP = previous;
        cleanupE2ETempDir(root);
        rmSync(retained, { recursive: true, force: true });
    }
});
