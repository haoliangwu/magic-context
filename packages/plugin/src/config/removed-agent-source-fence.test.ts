/// <reference types="bun-types" />

import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const RETIRED_AGENT_NAME = ["side", "kick"].join("");
const RETIRED_AGENT_PATTERN = new RegExp(RETIRED_AGENT_NAME, "gi");
const REPO_ROOT = join(__dirname, "..", "..", "..", "..");
const WARNING_SOURCE = join(
    REPO_ROOT,
    "packages",
    "plugin",
    "src",
    "config",
    "removed-agent-config.ts",
);
const SOURCE_ROOTS = [
    join(REPO_ROOT, "packages", "plugin", "src"),
    join(REPO_ROOT, "packages", "pi-plugin", "src"),
    join(REPO_ROOT, "packages", "cli", "src"),
    join(REPO_ROOT, "packages", "dashboard", "src"),
    join(REPO_ROOT, "packages", "dashboard", "src-tauri", "src"),
];
const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".rs", ".json"]);
// The dashboard labels sessions from other CortexKit agents, and one of their run
// kinds shares this name. These files name that external run kind, not the retired
// Magic Context agent, so they are allowed to mention it.
const EXTERNAL_RUN_KIND_FILES = new Set([
    join(REPO_ROOT, "packages", "dashboard", "src", "lib", "session-label.ts"),
    join(REPO_ROOT, "packages", "dashboard", "src", "lib", "session-label.test.ts"),
]);

function sourceFiles(directory: string, files: string[] = []): string[] {
    for (const entry of readdirSync(directory)) {
        if (entry === "node_modules" || entry === "dist") continue;
        const path = join(directory, entry);
        const stat = statSync(path);
        if (stat.isDirectory()) {
            sourceFiles(path, files);
            continue;
        }
        const extension = entry.slice(entry.lastIndexOf("."));
        if (stat.isFile() && SOURCE_EXTENSIONS.has(extension)) files.push(path);
    }
    return files;
}

describe("retired agent source fence", () => {
    it("keeps only the removed-config warning key literal", () => {
        const offenses: string[] = [];
        for (const file of SOURCE_ROOTS.flatMap((root) => sourceFiles(root))) {
            const matches = readFileSync(file, "utf8").match(RETIRED_AGENT_PATTERN) ?? [];
            const allowed =
                (file === WARNING_SOURCE && matches.length === 1) ||
                EXTERNAL_RUN_KIND_FILES.has(file);
            if (!allowed && matches.length > 0) {
                offenses.push(`${relative(REPO_ROOT, file)} (${matches.length})`);
            }
        }

        expect(offenses).toEqual([]);
        expect(readFileSync(WARNING_SOURCE, "utf8").match(RETIRED_AGENT_PATTERN)).toHaveLength(1);
    });
});
