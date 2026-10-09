import { afterEach, describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import {
    chmodSync,
    lstatSync,
    mkdirSync,
    readdirSync,
    readFileSync,
    readlinkSync,
    rmSync,
    statSync,
    symlinkSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { rememberGitIdentity } from "../features/magic-context/memory/project-identity-cache";
import { markAnnouncementSeen } from "./announcement";
import { getMagicContextStorageDir } from "./data-path";
import {
    __resetStoragePrivatePermissionEnforcementForTests,
    copyStorageFileSync,
    copyStorageTreeSync,
    ensureStorageDirectorySync,
    setStoragePrivatePermissionEnforcement,
    tightenStorageTreeSync,
    writeStorageFileAsync,
    writeStorageFileAtomicSync,
    writeStorageFileSync,
} from "./storage-permissions";

const roots: string[] = [];

function entriesBelow(path: string): string[] {
    const found = [path];
    const stat = lstatSync(path);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return found;
    for (const entry of readdirSync(path)) found.push(...entriesBelow(join(path, entry)));
    return found;
}

function assertPrivateTree(root: string): void {
    for (const entry of entriesBelow(root)) {
        const mode = statSync(entry).mode & 0o777;
        expect(mode & 0o077, `${entry} mode ${mode.toString(8)}`).toBe(0);
    }
}

afterEach(() => {
    __resetStoragePrivatePermissionEnforcementForTests();
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("owner-only storage permissions", () => {
    it("creates storage directories, ordinary files, and atomic temporaries privately, then tightens old entries", async () => {
        if (process.platform === "win32") return;
        const root = join(
            tmpdir(),
            "magic-context",
            `permissions-ts-${process.pid}-${randomUUID()}`,
        );
        roots.push(root);
        const storage = join(root, "cortexkit", "magic-context");

        ensureStorageDirectorySync(storage, true);
        writeStorageFileSync(join(storage, "last_announced_version"), "0.45.0", {
            forcePrivate: true,
        });
        writeStorageFileAtomicSync(join(storage, "last-update-check.json"), "{}\n", true);
        const snapshotPath = join(storage, "snapshot.heapsnapshot");
        await writeStorageFileAsync(snapshotPath, "snapshot", true);
        expect(statSync(snapshotPath).mode & 0o077).toBe(0);
        const legacy = join(storage, "project-identities");
        mkdirSync(legacy, { recursive: true });
        writeFileSync(join(legacy, "legacy.json"), "{}\n");
        chmodSync(legacy, 0o755);
        chmodSync(join(legacy, "legacy.json"), 0o644);

        const result = tightenStorageTreeSync(storage);

        expect(result.failures).toBe(0);
        expect(result.tightened).toBe(2);
        assertPrivateTree(storage);

        const copySource = join(root, "copy-source", "context.db");
        mkdirSync(dirname(copySource), { recursive: true });
        writeFileSync(copySource, "database fixture");
        const copyDestination = join(storage, "backup.db");
        copyStorageFileSync(copySource, copyDestination, true);
        expect(statSync(copyDestination).mode & 0o077).toBe(0);
    });

    it("copies cache symlinks without widening the copied tree", () => {
        if (process.platform === "win32") return;
        const root = join(tmpdir(), "magic-context", `copy-tree-ts-${process.pid}-${randomUUID()}`);
        roots.push(root);
        const source = join(root, "source");
        const destination = join(root, "data", "cortexkit", "magic-context", "models");
        mkdirSync(source, { recursive: true });
        writeFileSync(join(source, "blob"), "weights");
        symlinkSync("blob", join(source, "snapshot"));

        copyStorageTreeSync(source, destination, true);

        expect(lstatSync(join(destination, "snapshot")).isSymbolicLink()).toBe(true);
        expect(readlinkSync(join(destination, "snapshot"))).toBe("blob");
        assertPrivateTree(destination);
    });

    it("creates state and identity files through their public data-directory writers privately", () => {
        if (process.platform === "win32") return;
        const root = join(tmpdir(), "magic-context", `writers-ts-${process.pid}-${randomUUID()}`);
        roots.push(root);
        const previous = {
            testData: process.env.MAGIC_CONTEXT_TEST_DATA_DIR,
            xdgData: process.env.XDG_DATA_HOME,
            storage: process.env.MAGIC_CONTEXT_STORAGE_DIR,
        };
        process.env.MAGIC_CONTEXT_TEST_DATA_DIR = root;
        process.env.XDG_DATA_HOME = root;
        delete process.env.MAGIC_CONTEXT_STORAGE_DIR;
        setStoragePrivatePermissionEnforcement(true);
        try {
            const storage = getMagicContextStorageDir();
            ensureStorageDirectorySync(storage, true);
            rememberGitIdentity(join(root, "project"), "git:0123456789abcdef");
            markAnnouncementSeen("0.45.0");
            assertPrivateTree(storage);
        } finally {
            if (previous.testData === undefined) delete process.env.MAGIC_CONTEXT_TEST_DATA_DIR;
            else process.env.MAGIC_CONTEXT_TEST_DATA_DIR = previous.testData;
            if (previous.xdgData === undefined) delete process.env.XDG_DATA_HOME;
            else process.env.XDG_DATA_HOME = previous.xdgData;
            if (previous.storage === undefined) delete process.env.MAGIC_CONTEXT_STORAGE_DIR;
            else process.env.MAGIC_CONTEXT_STORAGE_DIR = previous.storage;
        }
    });

    it("keeps storage filesystem creation behind the shared helper", () => {
        const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../");
        const scanRoots = [
            "packages/plugin/src",
            "packages/pi-plugin/src",
            "packages/cli/src",
            "packages/dashboard/src",
        ];
        const directCreate =
            /(?:\b(?:fs\.)?(?:mkdirSync|mkdir|writeFileSync|writeFile|appendFileSync|appendFile|createWriteStream|copyFileSync|cpSync)\s*\(|\bBun\.write\s*\()/;
        const directOpenWrite = /\b(?:openSync|open)\s*\([^,]+,\s*["'](?:w|wx|a|ax|as|as\+)/;
        const offenders: string[] = [];
        const visit = (absolute: string): void => {
            for (const entry of readdirSync(absolute, { withFileTypes: true })) {
                const path = join(absolute, entry.name);
                if (entry.isDirectory()) {
                    if (entry.name !== "node_modules" && entry.name !== "dist") visit(path);
                    continue;
                }
                if (
                    !/\.(?:ts|tsx|js|mjs|cjs)$/.test(entry.name) ||
                    /(?:\.test|\.spec)\./.test(entry.name)
                )
                    continue;
                const source = readFileSync(path, "utf8");
                if (
                    !source.includes("getMagicContextStorageDir") ||
                    (!directCreate.test(source) && !directOpenWrite.test(source))
                )
                    continue;
                const relative = path.slice(repoRoot.length + 1);
                // Project .gitignore maintenance is outside the private data directory;
                // it writes only the shared per-project ignore file.
                if (relative === "packages/plugin/src/shared/data-path.ts") continue;
                // This migration command reads the MC store but writes only harness session files.
                if (relative === "packages/cli/src/commands/migrate.ts") continue;
                offenders.push(relative);
            }
        };
        for (const root of scanRoots) visit(join(repoRoot, root));
        for (const relative of [
            "packages/plugin/scripts/cache-bust-sentinel.ts",
            "packages/plugin/scripts/transform-latency-sentinel.ts",
            "packages/plugin/scripts/subagent-failure-sentinel.ts",
        ]) {
            const source = readFileSync(join(repoRoot, relative), "utf8");
            if (
                source.includes("getMagicContextStorageDir") &&
                (directCreate.test(source) || directOpenWrite.test(source))
            ) {
                offenders.push(relative);
            }
        }

        expect(offenders, `direct filesystem creators in storage-aware modules`).toEqual([]);
    });

    it("keeps shell backups and staging private from their first creation", () => {
        const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../");
        for (const script of ["scripts/restart-window.sh", "scripts/place-ck-mc.sh"]) {
            const source = readFileSync(join(repoRoot, script), "utf8");
            expect(source, script).toMatch(/^umask 077$/m);
        }
    });
});
