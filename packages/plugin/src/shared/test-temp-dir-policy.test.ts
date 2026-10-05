import { expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const packagesRoot = resolve(import.meta.dir, "../../..");

function testFiles(directory: string): string[] {
    return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
        const path = join(directory, entry.name);
        return entry.isDirectory()
            ? testFiles(path)
            : /\.(test|spec)\.[cm]?[jt]sx?$/.test(entry.name)
              ? [path]
              : [];
    });
}

it("source tests allocate temporary directories only through the registered helper", () => {
    // Ban the raw API name, including imports and aliases, rather than just one
    // spelling of a call. Nested fixtures also need registration on setup failure.
    const rawApi = new RegExp("\\b" + "mk" + "dtemp(?:Sync)?\\b");
    const violations = readdirSync(packagesRoot, { withFileTypes: true }).flatMap((entry) => {
        if (!entry.isDirectory()) return [];
        const src = join(packagesRoot, entry.name, "src");
        try {
            return testFiles(src).filter((path) => rawApi.test(readFileSync(path, "utf8")));
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
            throw error;
        }
    });
    expect(violations.map((path) => relative(packagesRoot, path))).toEqual([]);
});
