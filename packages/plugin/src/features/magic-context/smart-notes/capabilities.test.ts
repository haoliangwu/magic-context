import { describe, expect, test } from "bun:test";
import { mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createTestTempDirFromPath } from "../../../shared/test-temp-dir";

import { createSmartNoteCapabilities, isSecretDeniedPath } from "./capabilities";

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
    const dir = await createTestTempDirFromPath(path.join(tmpdir(), "mc-smart-note-cap-"));
    try {
        return await fn(dir);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
}

describe("smart-note readFile capability", () => {
    test("reads regular project files", async () => {
        await withTempDir(async (dir) => {
            await writeFile(path.join(dir, "README.md"), "hello", "utf8");
            const cap = createSmartNoteCapabilities({
                projectRoot: dir,
                signal: new AbortController().signal,
            });
            expect(await cap.readFile("README.md")).toBe("hello");
        });
    });

    test("denies secrets by path pattern", async () => {
        await withTempDir(async (dir) => {
            await mkdir(path.join(dir, "secrets"));
            for (const file of [".env", ".env.local", ".envrc", ".env-prod", ".env_local"]) {
                await writeFile(path.join(dir, file), "TOKEN=1", "utf8");
            }
            await writeFile(path.join(dir, "env.ts"), "export const env = {};", "utf8");
            await writeFile(path.join(dir, "environment.md"), "not a secret", "utf8");
            await writeFile(path.join(dir, ".npmrc"), "//token", "utf8");
            await writeFile(path.join(dir, "id_ed25519"), "key", "utf8");
            await writeFile(path.join(dir, "cert.pem"), "pem", "utf8");
            await writeFile(path.join(dir, "secrets", "value.txt"), "secret", "utf8");
            const cap = createSmartNoteCapabilities({
                projectRoot: dir,
                signal: new AbortController().signal,
            });
            for (const file of [
                ".env",
                ".env.local",
                ".envrc",
                ".env-prod",
                ".env_local",
                ".npmrc",
                "id_ed25519",
                "cert.pem",
                "secrets/value.txt",
            ]) {
                expect(await cap.readFile(file)).toBeNull();
            }
            expect(await cap.readFile("env.ts")).toBe("export const env = {};");
            expect(await cap.readFile("environment.md")).toBe("not a secret");
        });
    });

    test("rechecks canonical directory symlinks against the secret denylist", async () => {
        await withTempDir(async (dir) => {
            await mkdir(path.join(dir, "secrets"));
            await writeFile(path.join(dir, "secrets", "token.json"), "secret", "utf8");
            await symlink(path.join(dir, "secrets"), path.join(dir, "public"));
            const cap = createSmartNoteCapabilities({
                projectRoot: dir,
                signal: new AbortController().signal,
            });

            expect(await cap.readFile("public/token.json")).toBeNull();
        });
    });

    test("allows benign directory symlinks that remain inside the project", async () => {
        await withTempDir(async (dir) => {
            await mkdir(path.join(dir, "docs"));
            await writeFile(path.join(dir, "docs", "guide.txt"), "guide", "utf8");
            await symlink(path.join(dir, "docs"), path.join(dir, "public-docs"));
            const cap = createSmartNoteCapabilities({
                projectRoot: dir,
                signal: new AbortController().signal,
            });

            expect(await cap.readFile("public-docs/guide.txt")).toBe("guide");
        });
    });

    test("denies final symlink and parent symlink escapes", async () => {
        await withTempDir(async (dir) => {
            const outside = await createTestTempDirFromPath(
                path.join(tmpdir(), "mc-smart-note-outside-"),
            );
            try {
                await writeFile(path.join(outside, "outside.txt"), "outside", "utf8");
                await symlink(path.join(outside, "outside.txt"), path.join(dir, "link.txt"));
                await symlink(outside, path.join(dir, "linked-dir"));
                const cap = createSmartNoteCapabilities({
                    projectRoot: dir,
                    signal: new AbortController().signal,
                });
                expect(await cap.readFile("link.txt")).toBeNull();
                expect(await cap.readFile("linked-dir/outside.txt")).toBeNull();
            } finally {
                await rm(outside, { recursive: true, force: true });
            }
        });
    });
});

describe("smart-note secret path denylist", () => {
    test("blocks common credential file names and key material", () => {
        for (const file of [
            ".aws/credentials",
            ".pgpass",
            ".netrc",
            "certs/client.p12",
            "certs/client.pfx",
            "certs/server.crt",
            "certs/server.key",
            "certs/server.pem",
            "prod-service-account.json",
            "prod_service_account.json",
            ".config/gcloud/application_default_credentials.json",
            "gcloud/legacy_credentials/user/adc.json",
        ]) {
            expect(isSecretDeniedPath(file)).toBe(true);
        }
    });

    test("does not block ordinary similarly named project files", () => {
        for (const file of [
            "docs/certificate-notes.md",
            "src/keymap.ts",
            "service-accounting/report.json",
            "docs/gcloud-setup.md",
        ]) {
            expect(isSecretDeniedPath(file)).toBe(false);
        }
    });
});
