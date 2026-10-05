import { readFileSync } from "node:fs";
import { renderDecayedCompartments } from "../../src/hooks/magic-context/decay-render";

/** Public repository documentation and synthetic, tiered history; no session data. */
export function buildProseProbe(): Record<string, string> {
    const docs = ["ARCHITECTURE.md", "STRUCTURE.md"].map((name) =>
        readFileSync(new URL(`../../../../${name}`, import.meta.url), "utf8"),
    ).join("\n\n");
    // Match the 52-row production-shape fixture in decay-render.test.ts.
    const compartments = Array.from({ length: 52 }, (_, i) => {
        const prose = `The team investigated request ${i + 1}, compared the implementation with the documented contract, and added regression coverage. The cache preserves stable content while the sidebar reports provider token usage. Verification found no changes to served bytes. `;
        return {
            startMessage: i * 27 + 1,
            endMessage: (i + 1) * 27,
            startDate: "2026-09-21",
            endDate: "2026-09-21",
            title: `Request accounting review ${i + 1}`,
            content: "",
            p1: prose.repeat(12), p2: prose.repeat(6), p3: prose.repeat(3), p4: prose,
            importance: 30 + (i % 70), legacy: 0,
        };
    });
    return {
        docs: `<project-docs>\n${docs}\n</project-docs>`,
        history: `<session-history>\n${renderDecayedCompartments({ compartments, historyBudgetTokens: 60_000 })}\n</session-history>`,
        memory: `<project-memory>\n${Array.from({ length: 60 }, (_, i) => `#${i + 1}: Component ${i + 1} keeps rendered history deterministic. Provider accounting is a display concern; budget decisions use raw local estimates. Tests cover retries, cache reuse, and stable ordering before a release.`).join("\n")}\n</project-memory>`,
    };
}
