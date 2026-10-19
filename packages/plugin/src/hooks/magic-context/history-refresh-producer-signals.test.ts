/// <reference types="bun-types" />

import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

function repoRoot(): string {
    return process.cwd().endsWith(join("packages", "plugin"))
        ? join(process.cwd(), "../..")
        : process.cwd();
}

function sourceFiles(dir: string): string[] {
    const result: string[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) result.push(...sourceFiles(full));
        else if (entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
            result.push(full);
        }
    }
    return result;
}

function blockAround(source: string, index: number): string {
    let depth = 0;
    let start = 0;
    for (let i = index; i >= 0; i--) {
        const ch = source[i];
        if (ch === "}") depth++;
        if (ch === "{") {
            if (depth === 0) {
                start = i;
                break;
            }
            depth--;
        }
    }
    depth = 0;
    let end = source.length;
    for (let i = start; i < source.length; i++) {
        const ch = source[i];
        if (ch === "{") depth++;
        if (ch === "}") {
            depth--;
            if (depth === 0) {
                end = i;
                break;
            }
        }
    }
    return source.slice(start, end);
}

function findUnpairedOpenCodeProducers(): string[] {
    const root = repoRoot();
    const base = join(root, "packages/plugin/src");
    const failures: string[] = [];
    for (const file of sourceFiles(base)) {
        const source = readFileSync(file, "utf8");
        for (const match of source.matchAll(/historyRefreshSessions\.add\(/g)) {
            const block = blockAround(source, match.index ?? 0);
            if (
                !block.includes("pendingMaterializationSessions.add(") &&
                !/requestPendingMaterialization\([^;]*pendingMaterializationSessions/.test(block)
            ) {
                failures.push(relative(root, file));
            }
        }
    }
    return failures;
}

function findUnpairedPiProducers(): string[] {
    const root = repoRoot();
    const base = join(root, "packages/pi-plugin/src");
    const failures: string[] = [];
    for (const file of sourceFiles(base)) {
        const source = readFileSync(file, "utf8");
        for (const match of source.matchAll(/signalPiHistoryRefresh\(/g)) {
            const prefix = source.slice(Math.max(0, (match.index ?? 0) - 32), match.index ?? 0);
            if (prefix.includes("function ")) continue;
            if (
                !blockAround(source, match.index ?? 0).includes("signalPiPendingMaterialization(")
            ) {
                failures.push(relative(root, file));
            }
        }
    }
    return failures;
}

describe("history refresh producer signals", () => {
    it("pairs every history refresh with pending materialization", () => {
        expect(findUnpairedOpenCodeProducers()).toEqual([]);
        expect(findUnpairedPiProducers()).toEqual([]);
    });
});
