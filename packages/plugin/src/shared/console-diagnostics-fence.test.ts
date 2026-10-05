import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

// OpenCode and Pi pass plugin stdout/stderr straight through to the operator's
// terminal, so a `[magic-context]` line written with console.* lands in the
// middle of someone else's UI. Diagnostics belong in the Magic Context log file
// (shared/logger.ts). This fence scans production sources for console calls
// whose arguments carry the `[magic-context]` tag.
const repoRoot = resolve(import.meta.dir, "../../../../");
const scannedRoots = ["packages/plugin/src", "packages/pi-plugin/src"];

// Messages the operator is meant to read on the terminal. Each entry is a
// repo-relative path plus a substring of the call's text, so a new console
// call in an allow-listed file still trips the fence.
const userFacingAllowList: Array<{ path: string; contains: string; why: string }> = [
    {
        path: "packages/plugin/src/v2/hooks/context.ts",
        contains: "v2 host API unavailable",
        why: "startup error: the host lacks the required session API; shown once with the minimum version",
    },
    {
        path: "packages/plugin/src/plugin/tool-registry.ts",
        contains: "persistent storage unavailable; disabling magic-context tools",
        why: "startup error: storage failed to open, so no ctx_* tool is registered",
    },
    {
        path: "packages/plugin/src/v2/hooks/context.ts",
        contains: "v2 setup disabled by conflicting context hooks",
        why: "startup error: another plugin's context hook disables Magic Context",
    },
    {
        path: "packages/plugin/src/v2/hooks/context.ts",
        contains: "v2 storage unavailable",
        why: "startup error: storage failed to open; reported once per distinct failure",
    },
    {
        path: "packages/plugin/src/shared/data-path.ts",
        contains: "TEST BACKSTOP",
        why: "fires only under NODE_ENV=test, where the logger is silent and imports this module",
    },
];

// `[magic-context]` and `[magic-context][pi]`; the TUI's own `[magic-context-tui]`
// debug lines run in the host's TUI process and are not covered here.
const diagnosticTag = /\[magic-context\]/;

const consoleCall = /\bconsole\.(?:warn|log|error|info|debug)\(/g;

function isTestSource(relativePath: string): boolean {
    return (
        /\.test\.[cm]?[jt]sx?$/.test(relativePath) ||
        relativePath.split("/").includes("__tests__") ||
        relativePath.split("/").includes("test-support")
    );
}

function listSources(dir: string): string[] {
    const files: string[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
            if (entry.name === "node_modules") continue;
            files.push(...listSources(full));
        } else if (/\.[cm]?[jt]sx?$/.test(entry.name)) {
            files.push(full);
        }
    }
    return files;
}

/**
 * Return the text of a call's argument list, starting just after its opening
 * parenthesis. Quotes and template literals are skipped so a parenthesis in a
 * message does not end the call early; `${...}` holes are scanned as code.
 */
function callArguments(source: string, openParen: number): string {
    let depth = 1;
    const stack: string[] = [];
    let index = openParen + 1;
    while (index < source.length && depth > 0) {
        const char = source[index];
        const quote = stack.at(-1);
        if (quote === "'" || quote === '"') {
            if (char === "\\") index++;
            else if (char === quote) stack.pop();
        } else if (quote === "`") {
            if (char === "\\") index++;
            else if (char === "`") stack.pop();
            else if (char === "$" && source[index + 1] === "{") {
                stack.push("{");
                index++;
            }
        } else if (char === "'" || char === '"' || char === "`") {
            stack.push(char);
        } else if (char === "{" && stack.length > 0) {
            stack.push("{");
        } else if (char === "}" && quote === "{") {
            stack.pop();
        } else if (char === "(") {
            depth++;
        } else if (char === ")") {
            depth--;
        }
        index++;
    }
    return source.slice(openParen + 1, index - 1);
}

function findTaggedConsoleCalls(): string[] {
    const findings: string[] = [];
    for (const root of scannedRoots) {
        for (const file of listSources(resolve(repoRoot, root))) {
            const relativePath = relative(repoRoot, file).split("\\").join("/");
            if (isTestSource(relativePath)) continue;
            const source = readFileSync(file, "utf8");
            for (const match of source.matchAll(consoleCall)) {
                const args = callArguments(source, match.index + match[0].length - 1);
                if (!diagnosticTag.test(args)) continue;
                const allowed = userFacingAllowList.some(
                    (entry) => entry.path === relativePath && args.includes(entry.contains),
                );
                if (allowed) continue;
                const line = source.slice(0, match.index).split("\n").length;
                findings.push(`${relativePath}:${line}`);
            }
        }
    }
    return findings;
}

describe("console diagnostics fence", () => {
    test("no production source writes [magic-context] diagnostics to the host console", () => {
        expect(findTaggedConsoleCalls()).toEqual([]);
    });

    test("the scanner sees a tagged call nested in a template literal", () => {
        const sample =
            "console.warn(\n    `[${new Date().toISOString()}] [magic-context] x=${Math.round(1)}ms`,\n);";
        const open = sample.indexOf("(");
        expect(callArguments(sample, open)).toContain("[magic-context]");
        const untagged = 'console.warn("plain (paren"); const s = "[magic-context]";';
        expect(callArguments(untagged, untagged.indexOf("("))).not.toContain("[magic-context]");
    });
});
