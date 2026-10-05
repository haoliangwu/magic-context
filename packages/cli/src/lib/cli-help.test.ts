/// <reference types="bun-types" />

import { afterAll, describe, expect, it } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createTestTempDirFromPath } from "../../../plugin/src/shared/test-temp-dir";
import {
    DOCTOR_HELP,
    LIST_HIDDEN_SESSIONS_HELP,
    MERGE_IDENTITY_HELP,
    SETUP_HELP,
    SINGLE_STORE_HELP,
    subcommandHelp,
} from "./cli-help";

describe("subcommandHelp", () => {
    it("answers --help and -h for setup, doctor and the doctor subcommands it documents", () => {
        const cases: Array<[string[], string]> = [
            [["setup"], SETUP_HELP],
            [["doctor"], DOCTOR_HELP],
            [["doctor", "--fix"], DOCTOR_HELP],
            [["doctor", "single-store", "migrate"], SINGLE_STORE_HELP],
            [["doctor", "merge-identity", "--from", "a"], MERGE_IDENTITY_HELP],
            [["doctor", "list-hidden-sessions"], LIST_HIDDEN_SESSIONS_HELP],
        ];
        for (const [argv, expected] of cases) {
            expect(subcommandHelp([...argv, "--help"])).toBe(expected);
            expect(subcommandHelp([...argv, "-h"])).toBe(expected);
        }
    });

    it("leaves subcommands with their own help, and non-help calls, to the command", () => {
        for (const subcommand of ["migrate", "migrate-session", "repair-db"]) {
            expect(subcommandHelp(["doctor", subcommand, "--help"])).toBeNull();
        }
        expect(subcommandHelp(["doctor"])).toBeNull();
        expect(subcommandHelp(["doctor", "--fix"])).toBeNull();
        expect(subcommandHelp(["setup", "--dry-run"])).toBeNull();
        expect(subcommandHelp(["unknown", "--help"])).toBeNull();
    });
});

// End-to-end through `main()`: each command must print help and exit 0 without
// running. Every host path points into a throwaway root so a regression that
// did run a command could not touch the real OpenCode or Magic Context stores.
const root = createTestTempDirFromPath(join(tmpdir(), "mc-cli-help-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const cliEntry = resolve(import.meta.dir, "..", "index.ts");

async function runCli(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
    const child = Bun.spawn([process.execPath, cliEntry, ...args], {
        cwd: root,
        env: {
            PATH: process.env.PATH ?? "",
            HOME: root,
            XDG_DATA_HOME: join(root, "data"),
            XDG_CONFIG_HOME: join(root, "config"),
            XDG_STATE_HOME: join(root, "state"),
            XDG_CACHE_HOME: join(root, "cache"),
            OPENCODE_DB: join(root, "opencode.db"),
            MAGIC_CONTEXT_STORAGE_DIR: join(root, "magic-context"),
        },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        windowsHide: true,
    });
    const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
    ]);
    return { code, stdout, stderr };
}

describe("CLI --help per subcommand", () => {
    const commands: Array<[string[], string]> = [
        [["setup"], "Usage: magic-context setup"],
        [["doctor"], "Usage: magic-context doctor [options]"],
        [["doctor", "single-store", "migrate"], "Usage: magic-context doctor single-store migrate"],
        [["doctor", "merge-identities"], "Usage: magic-context doctor merge-identities"],
        [["doctor", "list-hidden-sessions"], "Usage: magic-context doctor list-hidden-sessions"],
        [["doctor", "migrate"], "Magic Context doctor migrate"],
        [["doctor", "migrate-session"], "doctor migrate-session"],
        [["doctor", "repair-db"], "Usage: magic-context doctor repair-db"],
    ];
    for (const [argv, expected] of commands) {
        for (const flag of ["--help", "-h"]) {
            it(`${argv.join(" ")} ${flag} prints help and exits 0`, async () => {
                const result = await runCli([...argv, flag]);
                expect(result.code).toBe(0);
                expect(result.stdout).toContain(expected);
                // The doctor and setup banners mean the command ran instead.
                expect(result.stdout).not.toContain("Magic Context Doctor");
                expect(result.stdout).not.toContain("Magic Context setup");
            }, 30_000);
        }
    }
});
