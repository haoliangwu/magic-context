import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type DocsProposalGitignoreResult =
    | { status: "added"; path: string }
    | { status: "covered" }
    | { status: "not-a-repository" }
    | { status: "failed"; path: string; error: string };

/** Paths a rule must ignore for proposal state to stay out of version control. */
const COVERING_PATHS = new Set([".cortexkit", ".cortexkit/magic-context"]);

/**
 * True when one .gitignore line ignores `.cortexkit/` or
 * `.cortexkit/magic-context/`: leading `/` and `**` + `/` anchors and a
 * trailing `/`, `/*` or `/**` are all equivalent for a directory rule.
 */
function coversProposalState(line: string): boolean {
    const rule = line.trim();
    if (rule === "" || rule.startsWith("#") || rule.startsWith("!")) return false;
    const normalized = rule
        .replace(/^\//, "")
        .replace(/^\*\*\//, "")
        .replace(/\/(\*\*?)?$/, "");
    return COVERING_PATHS.has(normalized);
}

/**
 * Keep per-project proposal state out of version control without changing unrelated ignore rules.
 *
 * Only a repository root is touched: setup runs from wherever the user opened
 * a terminal (home, Downloads), and creating a .gitignore there would be
 * stray. A `.cortexkit/.gitignore` that already ignores `magic-context/`
 * (the plugin writes one beside its artifacts) also counts as covered.
 * Best-effort: a write failure is reported, never thrown, because setup has
 * already finished its real work by then.
 */
export function ensureDocsProposalGitignore(projectDir: string): DocsProposalGitignoreResult {
    if (!existsSync(join(projectDir, ".git"))) return { status: "not-a-repository" };

    const path = join(projectDir, ".gitignore");
    try {
        const text = existsSync(path) ? readFileSync(path, "utf8") : "";
        if (text.split(/\r?\n/).some(coversProposalState)) return { status: "covered" };

        const nestedPath = join(projectDir, ".cortexkit", ".gitignore");
        if (existsSync(nestedPath)) {
            const nested = readFileSync(nestedPath, "utf8").split(/\r?\n/);
            if (nested.some((line) => /^\/?magic-context(\/(\*\*?)?)?$/.test(line.trim()))) {
                return { status: "covered" };
            }
        }

        appendFileSync(
            path,
            `${text && !text.endsWith("\n") ? "\n" : ""}.cortexkit/magic-context/\n`,
        );
        return { status: "added", path };
    } catch (error) {
        return {
            status: "failed",
            path,
            error: error instanceof Error ? error.message : String(error),
        };
    }
}
