import { createHash } from "node:crypto";
import { readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "bun:test";

import { cleanupTestTempDir, createTestTempDirFromPath } from "../../../plugin/src/shared/test-temp-dir";
import { cleanupE2ETempDir, createE2ETempDir } from "../temp-dir";
import { executableRootForTmpdir, stageExecutable } from "./executable-staging";

describe("content-named child executable staging", () => {
    it("keeps copies off the source tree, reuses identical bytes, and hashes changed bytes separately", () => {
        const fixtureDir = createE2ETempDir("magic-context-executable-test-");
        const firstSource = join(fixtureDir, "ck-mc");
        const changedSource = join(fixtureDir, "changed-ck-mc");
        let originalSource = firstSource;
        let changedBinary = changedSource;
        try {
            if (process.platform === "darwin") {
                originalSource = process.execPath;
                changedBinary = "/bin/ls";
            } else {
                writeFileSync(firstSource, "first binary contents", { mode: 0o700 });
                writeFileSync(changedSource, "changed binary contents", { mode: 0o700 });
            }

            const first = stageExecutable(originalSource, "ckdev-mc-stage-test", "ck-mc");
            const reused = stageExecutable(originalSource, "ckdev-mc-stage-test", "ck-mc");
            const changed = stageExecutable(changedBinary, "ckdev-mc-stage-test", "ck-mc");
            const expectedDigest = createHash("sha256").update(readFileSync(originalSource)).digest("hex");
            const changedDigest = createHash("sha256").update(readFileSync(changedBinary)).digest("hex");

            expect(first).toBe(reused);
            expect(first.startsWith(`${expectedStagingRoot()}/${expectedDigest}/`)).toBe(true);
            expect(first.startsWith(fixtureDir)).toBe(false);
            expect(first).not.toContain("/target/");
            expect(changed.split("/").at(-2)).toBe(changedDigest);
            expect(changed.split("/").at(-2)).not.toBe(first.split("/").at(-2));

            for (const path of [first, changed]) {
                expect(statSync(path).mode & 0o777).toBe(0o700);
                expect(statSync(join(path, "..")).mode & 0o777).toBe(0o700);
            }
            expect(statSync(expectedStagingRoot()).mode & 0o777).toBe(0o700);
        } finally {
            cleanupE2ETempDir(fixtureDir);
        }
    });

    it("uses TMPDIR outside /var/folders for staged executables", () => {
        const fixtureDir = createE2ETempDir("magic-context-executable-tmpdir-test-");
        const stagingDir = createTestTempDirFromPath(join(resolve(import.meta.dir, "../../../../"), ".magic-context-exec-tmpdir-"));
        const source = join(fixtureDir, "ck-mc");
        const previousTmpdir = process.env.TMPDIR;
        try {
            if (process.platform === "darwin") {
                writeFileSync(source, readFileSync(process.execPath), { mode: 0o700 });
            } else {
                writeFileSync(source, "test executable", { mode: 0o700 });
            }
            process.env.TMPDIR = stagingDir;

            const staged = stageExecutable(source, "ckdev-mc-tmpdir-test", "ck-mc");
            const digest = createHash("sha256").update(readFileSync(source)).digest("hex");

            expect(staged).toBe(join(stagingDir, "magic-context-exec", digest, "ckdev-mc-tmpdir-test"));
            expect(statSync(join(stagingDir, "magic-context-exec")).mode & 0o777).toBe(0o700);
        } finally {
            if (previousTmpdir === undefined) delete process.env.TMPDIR;
            else process.env.TMPDIR = previousTmpdir;
            cleanupTestTempDir(stagingDir);
            cleanupE2ETempDir(fixtureDir);
        }
    });

    it("falls back to /tmp when TMPDIR is unset or resolves under /var/folders", () => {
        const fallback = "/tmp/magic-context-exec";

        expect(executableRootForTmpdir()).toBe(fallback);
        expect(executableRootForTmpdir("/var/folders/abc", "/var/folders/abc")).toBe(fallback);
        expect(executableRootForTmpdir("/var/folders/abc", "/private/var/folders/abc")).toBe(fallback);
        expect(executableRootForTmpdir("/private/var/folders/abc", "/private/var/folders/abc")).toBe(fallback);
    });

    it("uses a TMPDIR outside /var/folders as the staging parent", () => {
        expect(executableRootForTmpdir("/worker/task-tmp", "/worker/task-tmp")).toBe(
            "/worker/task-tmp/magic-context-exec",
        );
    });

    it("flags direct process launches from Cargo build paths", () => {
        const planted = `
            const binary = join(root, "target/release/ck-mc");
            spawn(binary, []);
            spawn(join(root, "target/debug/ck-subc"), []);
        `;
        expect(findUnsafeBuildBinarySpawns(planted)).toHaveLength(2);
        const staged = `
            const executable = stageExecutable(join(root, "target/release/ck-mc"), "ckdev-mc", "ck-mc");
            spawn(executable, []);
        `;
        expect(findUnsafeBuildBinarySpawns(staged)).toHaveLength(0);
    });

    it("keeps Rust-mode e2e and rig executable launches off Cargo build paths", () => {
        const root = resolve(import.meta.dir, "../../../../");
        const files = collectTypeScriptFiles(join(root, "packages/e2e-tests"));
        files.push(join(root, "scripts/ckmc-write-probe/drive.ts"));
        const violations = files.flatMap((path) =>
            findUnsafeBuildBinarySpawns(readFileSync(path, "utf8"), path).map((line) => `${path}:${line}`),
        );
        expect(violations).toEqual([]);

        const migrationDrill = readFileSync(join(root, "scripts/b2-drill/migrate-drill.sh"), "utf8");
        expect(migrationDrill).toContain("stage-executable.ts");
        expect(migrationDrill).not.toContain('cp "$CK_MC" "$RUN/bin/ckdev-mc"');
    });
});

function findUnsafeBuildBinarySpawns(source: string, filename = "fixture.ts"): number[] {
    const file = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const initializers = new Map<string, ts.Expression>();
    const collectInitializers = (node: ts.Node): void => {
        if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
            initializers.set(node.name.text, node.initializer);
        }
        ts.forEachChild(node, collectInitializers);
    };
    collectInitializers(file);

    const lineNumbers: number[] = [];
    const isBinaryBuildPath = (expression: ts.Expression, seen = new Set<string>()): boolean => {
        const text = expression.getText(file);
        if (ts.isCallExpression(expression)) {
            const callee = expression.expression;
            const name = ts.isIdentifier(callee)
                ? callee.text
                : ts.isPropertyAccessExpression(callee)
                  ? callee.name.text
                  : "";
            if (name === "stageExecutable" || name === "stageDevBinary") return false;
        }
        if (/CARGO_BIN_EXE_|(?:target|CARGO_TARGET_DIR|RUST_E2E_CARGO_TARGET_DIR)[^,;]*(?:ck-mc|ck-subc|ckdev-|slow_transform_probe)/i.test(text)) {
            return true;
        }
        if (ts.isIdentifier(expression) && !seen.has(expression.text)) {
            const initializer = initializers.get(expression.text);
            if (initializer) {
                seen.add(expression.text);
                return isBinaryBuildPath(initializer, seen);
            }
        }
        return false;
    };
    const visit = (node: ts.Node): void => {
        if (ts.isCallExpression(node)) {
            const callee = node.expression;
            const name = ts.isIdentifier(callee)
                ? callee.text
                : ts.isPropertyAccessExpression(callee)
                  ? callee.name.text
                  : "";
            if (["spawn", "spawnSync", "execFile", "execFileSync"].includes(name)) {
                const executable = node.arguments[0];
                if (executable && isBinaryBuildPath(executable)) {
                    lineNumbers.push(file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1);
                }
            }
        }
        ts.forEachChild(node, visit);
    };
    visit(file);
    return lineNumbers;
}

function collectTypeScriptFiles(directory: string): string[] {
    const files: string[] = [];
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
        if ([".cache", "node_modules", "target", "dist"].includes(entry.name)) continue;
        const path = join(directory, entry.name);
        if (entry.isDirectory()) files.push(...collectTypeScriptFiles(path));
        else if (/\.(?:[cm]?tsx?)$/.test(entry.name)) files.push(path);
    }
    return files;
}

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
