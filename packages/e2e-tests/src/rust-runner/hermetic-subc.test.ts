/// <reference types="bun-types" />

import { describe, expect, it } from "bun:test";
import { mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { __hermeticSubcTest } from "./hermetic-subc";
import { createTestTempDirFromPath } from "../../../plugin/src/shared/test-temp-dir";

describe("hermetic Rust process isolation", () => {
    it("uses an e2e-owned Cargo target directory", () => {
        expect(__hermeticSubcTest.rustE2eCargoTargetDir).toBe(
            join(import.meta.dir, "../../.cache/rust-e2e-cargo-target"),
        );
        expect(__hermeticSubcTest.rustE2eCargoTargetDir).not.toContain("subconscious/target");
        expect(__hermeticSubcTest.rustE2eCargoEnv().CARGO_TARGET_DIR).toBe(
            __hermeticSubcTest.rustE2eCargoTargetDir,
        );
    });

    it("ignores a prebuilt module override when selecting the hermetic binary", () => {
        expect(__hermeticSubcTest.currentTreeCkMcBinary("/tmp/stale/ck-mc")).toBe(
            join(__hermeticSubcTest.rustE2eCargoTargetDir, "release/ck-mc"),
        );
    });

    it("stages a runnable test binary under a ckdev process name", () => {
        const scratchParent = join(tmpdir(), "magic-context", "e2e-binary-stage-test");
        mkdirSync(scratchParent, { recursive: true });
        const scratch = createTestTempDirFromPath(join(scratchParent, "run-"));
        try {
            const source = process.platform === "darwin" ? process.execPath : join(scratch, "ck-mc");
            if (process.platform !== "darwin") writeFileSync(source, "test executable");
            const staged = __hermeticSubcTest.stageDevBinary(source, "ckdev-mc-e2e-test");

            expect(staged.startsWith(`${expectedStagingRoot()}/`)).toBe(true);
            expect(staged).toContain("/ckdev-mc-e2e-test");
            if (process.platform !== "darwin") {
                expect(readFileSync(staged, "utf8")).toBe("test executable");
            }
        } finally {
            rmSync(scratch, { recursive: true, force: true });
        }
    });

    it("reaps only stale PID records", () => {
        const nowMs = 10 * __hermeticSubcTest.stalePidAgeMs;

        expect(
            __hermeticSubcTest.isStaleRustE2ePidRecord(
                nowMs - __hermeticSubcTest.stalePidAgeMs + 1,
                nowMs,
            ),
        ).toBe(false);
        expect(
            __hermeticSubcTest.isStaleRustE2ePidRecord(
                nowMs - __hermeticSubcTest.stalePidAgeMs,
                nowMs,
            ),
        ).toBe(true);
        expect(__hermeticSubcTest.isStaleRustE2ePidRecord(nowMs + 1, nowMs)).toBe(false);
        expect(__hermeticSubcTest.isStaleRustE2ePidRecord(Number.NaN, nowMs)).toBe(false);
    });
});

function expectedStagingRoot(): string {
    const tmpDir = process.env.TMPDIR;
    if (!tmpDir) return "/tmp/magic-context-exec";
    let resolvedTmpDir: string;
    try {
        resolvedTmpDir = realpathSync(tmpDir);
    } catch {
        return "/tmp/magic-context-exec";
    }
    if (
        ["/var/folders", "/private/var/folders"].some(
            (prefix) => resolvedTmpDir === prefix || resolvedTmpDir.startsWith(`${prefix}/`),
        )
    ) {
        return "/tmp/magic-context-exec";
    }
    return join(tmpDir, "magic-context-exec");
}
