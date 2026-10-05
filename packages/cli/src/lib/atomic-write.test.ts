import { afterEach, describe, expect, it } from "bun:test";
import {
    chmodSync,
    existsSync,
    lstatSync,
    mkdirSync,
    readdirSync,
    readFileSync,
    rmSync,
    statSync,
    symlinkSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestTempDirFromPath } from "../../../plugin/src/shared/test-temp-dir";
import { writeFileAtomic } from "./atomic-write";

const roots: string[] = [];

afterEach(() => {
    for (const root of roots.splice(0)) {
        rmSync(root, { recursive: true, force: true });
    }
});

describe("writeFileAtomic", () => {
    it("writes content and leaves no .tmp sibling", () => {
        const root = createTestTempDirFromPath(join(tmpdir(), "mc-atomic-"));
        roots.push(root);
        const target = join(root, "config.jsonc");
        writeFileAtomic(target, '{"ok":true}\n');
        expect(readFileSync(target, "utf-8")).toBe('{"ok":true}\n');
        expect(existsSync(`${target}.tmp`)).toBe(false);
    });

    it("preserves file mode on replace", () => {
        const root = createTestTempDirFromPath(join(tmpdir(), "mc-atomic-mode-"));
        roots.push(root);
        const target = join(root, "config.jsonc");
        writeFileAtomic(target, "v1\n");
        chmodSync(target, 0o600);
        writeFileAtomic(target, "v2\n");
        expect(readFileSync(target, "utf-8")).toBe("v2\n");
        expect(statSync(target).mode & 0o777).toBe(0o600);
    });

    it("creates missing parent directories (fresh CortexKit config location)", () => {
        const root = createTestTempDirFromPath(join(tmpdir(), "mc-atomic-mkdir-"));
        roots.push(root);
        // Nested path whose parents do NOT exist yet — mirrors a first-ever setup
        // writing ~/.config/cortexkit/magic-context.jsonc on a clean machine.
        const target = join(root, "cortexkit", "nested", "magic-context.jsonc");
        expect(existsSync(join(root, "cortexkit"))).toBe(false);
        writeFileAtomic(target, '{"created":true}\n');
        expect(readFileSync(target, "utf-8")).toBe('{"created":true}\n');
        expect(existsSync(`${target}.tmp`)).toBe(false);
    });
});

describe("writeFileAtomic through symlinks and failures", () => {
    function siblings(dir: string): string[] {
        return readdirSync(dir).sort();
    }

    it("writes through a symlinked config instead of replacing the link", () => {
        const root = createTestTempDirFromPath(join(tmpdir(), "mc-atomic-link-"));
        roots.push(root);
        const dotfiles = join(root, "dotfiles");
        mkdirSync(dotfiles);
        const real = join(dotfiles, "magic-context.jsonc");
        writeFileSync(real, "v1\n");
        chmodSync(real, 0o600);
        const link = join(root, "magic-context.jsonc");
        symlinkSync(real, link);

        writeFileAtomic(link, "v2\n");

        expect(lstatSync(link).isSymbolicLink()).toBe(true);
        expect(readFileSync(real, "utf-8")).toBe("v2\n");
        expect(statSync(real).mode & 0o777).toBe(0o600);
        expect(siblings(dotfiles)).toEqual(["magic-context.jsonc"]);
    });

    it("follows a relative symlink chain to a missing target and creates it", () => {
        const root = createTestTempDirFromPath(join(tmpdir(), "mc-atomic-dangling-"));
        roots.push(root);
        mkdirSync(join(root, "store"));
        symlinkSync("store/real.jsonc", join(root, "middle.jsonc"));
        symlinkSync("middle.jsonc", join(root, "config.jsonc"));

        writeFileAtomic(join(root, "config.jsonc"), "created\n");

        expect(lstatSync(join(root, "config.jsonc")).isSymbolicLink()).toBe(true);
        expect(readFileSync(join(root, "store", "real.jsonc"), "utf-8")).toBe("created\n");
    });

    it("never touches another writer's temp file at the old fixed name", () => {
        const root = createTestTempDirFromPath(join(tmpdir(), "mc-atomic-tmpname-"));
        roots.push(root);
        const target = join(root, "config.jsonc");
        writeFileSync(`${target}.tmp`, "another writer\n");

        writeFileAtomic(target, "mine\n");

        expect(readFileSync(target, "utf-8")).toBe("mine\n");
        expect(readFileSync(`${target}.tmp`, "utf-8")).toBe("another writer\n");
        expect(siblings(root)).toEqual(["config.jsonc", "config.jsonc.tmp"]);
    });

    it("removes its temp file when the final rename fails", () => {
        const root = createTestTempDirFromPath(join(tmpdir(), "mc-atomic-fail-"));
        roots.push(root);
        // A non-empty directory at the target path makes rename() fail.
        const target = join(root, "config.jsonc");
        mkdirSync(target);
        writeFileSync(join(target, "keep"), "x");

        expect(() => writeFileAtomic(target, "lost\n")).toThrow();
        expect(siblings(root)).toEqual(["config.jsonc"]);
    });
});
