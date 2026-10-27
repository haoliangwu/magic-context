import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { createTestTempDirFromPath } from "./test-temp-dir";

/**
 * `announcement.ts` reads/writes a single `last_announced_version` file under
 * `getMagicContextStorageDir()`. The behavior we test:
 *   1. `markAnnouncementSeen` then `readLastAnnouncedVersion` round-trips
 *   2. `shouldShowAnnouncement` returns false after a matching mark
 *   3. `shouldShowAnnouncement` returns true after a non-matching (older) mark
 *   4. `shouldShowAnnouncement` seeds state + returns false on first run / wiped
 *      sandbox (no prior file), so fresh installs and ephemeral envs aren't
 *      spammed with a changelog (issue #99)
 *   5. Empty-version inputs are no-ops (don't crash, don't write garbage)
 *
 * We isolate writes by pointing `XDG_DATA_HOME` at a temp dir before requiring
 * the module fresh per test, since the module captures the storage path at
 * import time via `getMagicContextStorageDir()`.
 */

let tmpRoot = "";
let originalXdg: string | undefined;
let fixtureCounter = 0;
let fixturePath = "";

async function loadAnnouncement(version = "1.2.3", features = ["Fixture announcement"]) {
    // Load the real gate with pinned release content, without a process-global module mock.
    const source = fs.readFileSync(path.join(import.meta.dir, "announcement.ts"), "utf8");
    const pinned = source
        .replace(
            /export const ANNOUNCEMENT_VERSION = .*?;/s,
            `export const ANNOUNCEMENT_VERSION = ${JSON.stringify(version)};`,
        )
        .replace(
            /export const ANNOUNCEMENT_FEATURES: ReadonlyArray<string> = \[[\s\S]*?\];/,
            `export const ANNOUNCEMENT_FEATURES: ReadonlyArray<string> = ${JSON.stringify(features)};`,
        )
        .replace(
            /from "(\.[^"]+)"/g,
            (_, specifier) => `from ${JSON.stringify(path.resolve(import.meta.dir, specifier))}`,
        );
    const scratch = path.resolve(import.meta.dir, "../../../../target/scratch");
    fs.mkdirSync(scratch, { recursive: true });
    fixturePath = path.join(scratch, `announcement-${process.pid}-${fixtureCounter++}.ts`);
    fs.writeFileSync(fixturePath, pinned);
    const mod = (await import(pathToFileURL(fixturePath).href)) as typeof import("./announcement");
    expect(mod.ANNOUNCEMENT_VERSION).toBe(version);
    expect(mod.ANNOUNCEMENT_FEATURES).toEqual(features);
    return mod;
}

beforeEach(() => {
    tmpRoot = createTestTempDirFromPath(path.join(os.tmpdir(), "mc-announcement-test-"));
    originalXdg = process.env.XDG_DATA_HOME;
    process.env.XDG_DATA_HOME = tmpRoot;
});

afterEach(() => {
    if (fixturePath) fs.rmSync(fixturePath, { force: true });
    if (originalXdg === undefined) {
        delete process.env.XDG_DATA_HOME;
    } else {
        process.env.XDG_DATA_HOME = originalXdg;
    }
    try {
        // maxRetries/retryDelay ride out transient EBUSY/EPERM on Windows.
        fs.rmSync(tmpRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    } catch {
        // best-effort
    }
});

describe("announcement state persistence", () => {
    test("round-trips a dismissed version through the file", async () => {
        // Fresh import after XDG override so the module captures the temp path
        const mod = await loadAnnouncement();
        const { readLastAnnouncedVersion, markAnnouncementSeen } = mod;

        expect(readLastAnnouncedVersion()).toBe("");

        markAnnouncementSeen("9.9.9");
        expect(readLastAnnouncedVersion()).toBe("9.9.9");

        markAnnouncementSeen("9.9.10");
        expect(readLastAnnouncedVersion()).toBe("9.9.10");
    });

    test("ignores empty / zero-length version marks", async () => {
        const mod = await loadAnnouncement();
        const { readLastAnnouncedVersion, markAnnouncementSeen } = mod;

        markAnnouncementSeen("");
        expect(readLastAnnouncedVersion()).toBe("");
    });

    test("creates the storage directory if it does not exist", async () => {
        const mod = await loadAnnouncement();
        const { markAnnouncementSeen } = mod;

        // Storage dir lives under tmpRoot + cortexkit/magic-context — does not
        // exist yet at the start of the test
        const expectedDir = path.join(tmpRoot, "cortexkit", "magic-context");
        expect(fs.existsSync(expectedDir)).toBe(false);

        markAnnouncementSeen("0.21.7");

        expect(fs.existsSync(expectedDir)).toBe(true);
        expect(fs.readFileSync(path.join(expectedDir, "last_announced_version"), "utf-8")).toBe(
            "0.21.7",
        );
    });

    test("trims whitespace from stored version on read", async () => {
        const mod = await loadAnnouncement();
        const { readLastAnnouncedVersion } = mod;

        const dir = path.join(tmpRoot, "cortexkit", "magic-context");
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, "last_announced_version"), "  1.2.3  \n");

        expect(readLastAnnouncedVersion()).toBe("1.2.3");
    });
});

describe("shouldShowAnnouncement gating", () => {
    test("empty release content does not announce or seed state", async () => {
        for (const [version, features] of [
            ["", ["Fixture"]],
            ["1.2.3", []],
        ] as const) {
            const mod = await loadAnnouncement(version, [...features]);
            expect(mod.shouldShowAnnouncement()).toBe(false);
            expect(mod.readLastAnnouncedVersion()).toBe("");
            fs.rmSync(fixturePath);
        }
    });
    test("returns false when the live version is already marked", async () => {
        const mod = await loadAnnouncement();
        const { ANNOUNCEMENT_VERSION, markAnnouncementSeen, shouldShowAnnouncement } = mod;

        markAnnouncementSeen(ANNOUNCEMENT_VERSION);
        expect(shouldShowAnnouncement()).toBe(false);
    });

    test("seeds state and returns false on first run / wiped sandbox (issue #99)", async () => {
        const mod = await loadAnnouncement();
        const { ANNOUNCEMENT_VERSION, shouldShowAnnouncement, readLastAnnouncedVersion } = mod;

        // No mark exists yet (fresh install or ephemeral/wiped sandbox). The
        // gate must NOT announce — it seeds the state to the current version and
        // returns false, so first-run users and disposable containers are never
        // spammed with a changelog they have no context for.
        expect(readLastAnnouncedVersion()).toBe("");
        expect(shouldShowAnnouncement()).toBe(false);
        // The seed was written, so a subsequent check stays quiet too.
        expect(readLastAnnouncedVersion()).toBe(ANNOUNCEMENT_VERSION);
        expect(shouldShowAnnouncement()).toBe(false);
    });

    test("does not seed or advance state when an existing state file is unreadable/corrupt", async () => {
        const mod = await loadAnnouncement();
        const { shouldShowAnnouncement } = mod;

        const dir = path.join(tmpRoot, "cortexkit", "magic-context");
        const file = path.join(dir, "last_announced_version");
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(file, "");

        expect(shouldShowAnnouncement()).toBe(false);
        expect(fs.readFileSync(file, "utf-8")).toBe("");
    });

    test("returns true when a different (older) version is marked", async () => {
        const mod = await loadAnnouncement();
        const { markAnnouncementSeen, shouldShowAnnouncement } = mod;

        markAnnouncementSeen("0.0.0-pre-historic");
        expect(shouldShowAnnouncement()).toBe(true);
    });

    test("does NOT re-announce on a downgrade (stored version is newer)", async () => {
        const mod = await loadAnnouncement();
        const { markAnnouncementSeen, shouldShowAnnouncement } = mod;

        // Stored version is far newer than the running binary (user downgraded).
        // A bare string-inequality gate would re-show the OLD announcement; the
        // semver gate must stay quiet (current is NOT > stored).
        markAnnouncementSeen("999.0.0");
        expect(shouldShowAnnouncement()).toBe(false);
    });
});
