/// <reference types="bun-types" />

// Regression guard: the `auto_drop_tool_age` and `drop_tool_structure` config
// keys (and their camelCase threads `autoDropToolAge` / `dropToolStructure`)
// were REMOVED in Phase 2 — routine age-based tool drops were replaced by the
// tiered target-headroom emergency drop, which always full-drops. No production
// source in the plugin or Pi packages may reference them; a stray reference
// would either be dead code or a config the schema now rejects with a warning.
//
// This is a static source-text scan so it fails at test-time without runtime
// mocking. Tests, generated files, and the doctor's deletion routine (which
// must name the dead keys to strip them) are intentionally excluded.

import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const PLUGIN_SRC = join(__dirname, "..");
const PI_SRC = join(__dirname, "..", "..", "..", "pi-plugin", "src");

const FORBIDDEN = [
    "auto_drop_tool_age",
    "drop_tool_structure",
    "autoDropToolAge",
    "dropToolStructure",
    // Nudge redesign removed the rolling/iteration nudge config entirely
    // (Channel 1/2 replaced them). No schema key, no camelCase thread.
    "nudge_interval_tokens",
    "iteration_nudge_threshold",
    "nudgeIntervalTokens",
    "iterationNudgeThreshold",
];

// Files allowed to mention the dead keys: the CLI doctor names them to strip
// them from existing user configs. (The doctor lives in packages/cli, not
// scanned here, but keep this list as the documented exception surface.)
const ALLOWED_BASENAMES = new Set<string>([]);

function walkSourceFiles(dir: string, out: string[] = []): string[] {
    const entries = readdirSync(dir);
    for (const entry of entries) {
        if (entry === "node_modules" || entry === "dist") continue;
        const full = join(dir, entry);
        const s = statSync(full);
        if (s.isDirectory()) {
            walkSourceFiles(full, out);
        } else if (
            s.isFile() &&
            entry.endsWith(".ts") &&
            !entry.endsWith(".test.ts") &&
            !entry.endsWith(".gen.ts") &&
            !ALLOWED_BASENAMES.has(entry)
        ) {
            out.push(full);
        }
    }
    return out;
}

function scanForForbidden(files: string[]): string[] {
    const offenders: string[] = [];
    for (const file of files) {
        const text = readFileSync(file, "utf-8");
        for (const key of FORBIDDEN) {
            if (text.includes(key)) offenders.push(`${file}: ${key}`);
        }
    }
    return offenders;
}

const REPO_ROOT = join(__dirname, "..", "..", "..", "..");

describe("removed Phase 2 config keys", () => {
    it("no production source references auto_drop_tool_age / drop_tool_structure", () => {
        const files = [PLUGIN_SRC, PI_SRC].flatMap((root) => {
            const found = walkSourceFiles(root);
            expect(found).toContain(join(root, "index.ts"));
            return found;
        });
        expect(scanForForbidden(files)).toEqual([]);
    });

    // The keys also leaked into docs, the generated schema, and e2e test
    // configs (where they're silently ignored — the worst kind, since the test
    // reads as if the knob still works). Guard those surfaces too so doc/config
    // drift fails CI alongside source drift.
    it("no docs / generated schema / e2e config references the removed keys", () => {
        const docFiles = [
            join(REPO_ROOT, "CONFIGURATION.md"),
            join(REPO_ROOT, "README.md"),
            join(REPO_ROOT, "assets", "magic-context.schema.json"),
        ];
        const e2eFiles = walkSourceFiles(join(REPO_ROOT, "packages", "e2e-tests", "tests"));
        // walkSourceFiles skips .test.ts, so collect e2e .test.ts explicitly.
        const e2eDir = join(REPO_ROOT, "packages", "e2e-tests", "tests");
        const e2eEntries = readdirSync(e2eDir)
            .filter((f) => f.endsWith(".ts"))
            .map((f) => join(e2eDir, f));
        expect(e2eEntries.length).toBeGreaterThan(0);
        expect(scanForForbidden([...docFiles, ...e2eFiles, ...e2eEntries])).toEqual([]);
    });
});
