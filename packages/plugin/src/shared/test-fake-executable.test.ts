import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname } from "node:path";
import { testExecutableRoot, writeTestExecutable } from "./test-fake-executable";

// Fixed contents on purpose: a random body would create a new executable on
// every run, which is exactly what the helper exists to avoid.
const STUB = "#!/bin/sh\necho test-fake-executable-helper\n";

describe("writeTestExecutable", () => {
    it("places the stub at a content-addressed path under the shared root", () => {
        const path = writeTestExecutable("helper-stub", STUB);

        expect(basename(path)).toBe("helper-stub");
        expect(dirname(dirname(path))).toBe(testExecutableRoot());
        expect(basename(dirname(path))).toMatch(/^[0-9a-f]{16}$/);
        expect(readFileSync(path, "utf8")).toBe(STUB);
        if (process.platform !== "win32") expect(statSync(path).mode & 0o111).not.toBe(0);
        expect(readdirSync(dirname(path))).toEqual(["helper-stub"]);
    });

    it("reuses the existing file instead of rewriting it", () => {
        const first = writeTestExecutable("helper-stub", STUB);
        const before = statSync(first);
        const second = writeTestExecutable("helper-stub", STUB);
        const after = statSync(second);

        expect(second).toBe(first);
        expect(after.ino).toBe(before.ino);
        expect(after.mtimeMs).toBe(before.mtimeMs);
    });

    it("gives different content or a different name a different directory", () => {
        const base = writeTestExecutable("helper-stub", STUB);
        const otherContent = writeTestExecutable("helper-stub", `${STUB}exit 0\n`);
        const otherName = writeTestExecutable("helper-stub-2", STUB);

        expect(new Set([dirname(base), dirname(otherContent), dirname(otherName)]).size).toBe(3);
    });

    it("keeps a directory-name prefix verbatim before the hash", () => {
        const prefix = "mc %MC_TEST% & shim ";
        const path = writeTestExecutable("helper-stub", STUB, { dirPrefix: prefix });
        const dirName = basename(dirname(path));

        expect(dirName.startsWith(prefix)).toBe(true);
        expect(dirName.slice(prefix.length)).toMatch(/^[0-9a-f]{16}$/);
    });

    it("rejects names that would escape the stub directory", () => {
        expect(() => writeTestExecutable("../escape", STUB)).toThrow();
        expect(() => writeTestExecutable("stub", STUB, { dirPrefix: "a/b" })).toThrow();
    });
});
