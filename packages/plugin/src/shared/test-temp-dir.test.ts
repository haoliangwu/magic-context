import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, utimesSync } from "node:fs";
import { join } from "node:path";
import {
    cleanupTestTempDir,
    createTestTempDir,
    createTestTempDirFromPath,
    sweepStaleTestTempDirs,
    withTestTempDir,
} from "./test-temp-dir";

const tempDirs: string[] = [];

afterEach(() => {
    for (const directory of tempDirs.splice(0)) cleanupTestTempDir(directory);
});

function createFixtureRoot(): string {
    const { dir } = createTestTempDir("mc-test-temp-dir-helper-");
    tempDirs.push(dir);
    return dir;
}

describe("test temp directories", () => {
    it("rejects labels that could escape the system temp directory", () => {
        for (const label of [
            "",
            ".",
            "..",
            "../outside-",
            "nested/path-",
            "nested\\path-",
            "nul\0-",
        ]) {
            expect(() => createTestTempDir(label)).toThrow("single path segments");
        }
    });
    it("cleans and sweeps previously unknown labels", () => {
        const root = createFixtureRoot();
        const dir = createTestTempDirFromPath(join(root, "previously-unlisted-"));
        expect(existsSync(dir)).toBe(true);
        const old = new Date(Date.now() - 7_200_000);
        utimesSync(dir, old, old);
        expect(sweepStaleTestTempDirs({ tempDir: root })).toContain(dir);
        expect(existsSync(dir)).toBe(false);
        cleanupTestTempDir(dir);
        const fixture = createTestTempDir("another-unlisted-");
        fixture.cleanup();
        expect(existsSync(fixture.dir)).toBe(false);
    });
    it("removes a root when its fixture callback throws", () => {
        let directory = "";

        expect(() =>
            withTestTempDir("mc-test-temp-dir-helper-", (tempDir) => {
                directory = tempDir;
                throw new Error("fixture setup failed");
            }),
        ).toThrow("fixture setup failed");

        expect(existsSync(directory)).toBe(false);
    });

    it("sweeps only aged directories with recognized prefixes", () => {
        const root = createFixtureRoot();
        const staleRecognized = join(root, "mc-config-secret-stale");
        const freshRecognized = join(root, "mc-config-secret-fresh");
        const staleBystander = join(root, "unrelated-tool-stale");
        const nowMs = Date.now();

        for (const directory of [staleRecognized, freshRecognized, staleBystander]) {
            mkdirSync(directory);
        }
        utimesSync(staleRecognized, new Date(nowMs - 7_200_000), new Date(nowMs - 7_200_000));
        utimesSync(staleBystander, new Date(nowMs - 7_200_000), new Date(nowMs - 7_200_000));

        const removed = sweepStaleTestTempDirs({ tempDir: root, nowMs });

        expect(removed).toEqual([staleRecognized]);
        expect(existsSync(staleRecognized)).toBe(false);
        expect(existsSync(freshRecognized)).toBe(true);
        expect(existsSync(staleBystander)).toBe(true);
    });
});
