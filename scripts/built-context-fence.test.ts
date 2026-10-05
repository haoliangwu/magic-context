import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Inspect emitted declarations rather than source imports: a stale cached chunk
// can ship a different schema ceiling even when the source fence is correct.
for (const pkg of ["plugin", "pi-plugin", "cli"]) {
    test(`built ${pkg} context fence is 92`, () => {
        const dist = join(import.meta.dir, "..", "packages", pkg, "dist");
        const declarations: { file: string; version: number }[] = [];
        for (const file of new Bun.Glob("**/*.js").scanSync(dist)) {
            const code = readFileSync(join(dist, file), "utf8");
            for (const match of code.matchAll(/\bLATEST_SUPPORTED_VERSION\s*=\s*(\d+)/g)) {
                declarations.push({ file, version: Number(match[1]) });
            }
        }
        expect(declarations.length).toBeGreaterThan(0);
        expect(declarations.filter(({ version }) => version !== 92)).toEqual([]);
    });
}
