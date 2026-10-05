import { describe, expect, spyOn, test } from "bun:test";
import type { Memory } from "../../features/magic-context/memory/types";
import { buildCompartmentAgentPrompt, COMPARTMENT_AGENT_SYSTEM_PROMPT } from "./compartment-prompt";
import { calibrationForModelKey, providerMass } from "./decision-calibration";
import { fitHistorianPrompt, type HistorianPromptFitArgs } from "./historian-prompt-fit";
import { PRODUCER_WINDOW_REFUSAL_MARGIN, producerInputTokenLimit } from "./producer-window-guard";
import * as formatting from "./read-session-formatting";
import { estimateTokens } from "./read-session-formatting";
import { buildReferenceBlocks, type ReferenceCompartment } from "./reference-retrieval";

const MODEL = "test/unknown-historian";

function memory(index: number, words = 40): Memory {
    return {
        id: index + 1,
        projectPath: "/project",
        category: index % 2 === 0 ? "ARCHITECTURE" : "CONSTRAINTS",
        content: `Fact ${index}: ${"the ledger keeps every decision ".repeat(words / 5)}`,
    } as Memory;
}

function compartment(index: number): ReferenceCompartment {
    return {
        startMessage: index * 10 + 1,
        endMessage: index * 10 + 10,
        title: `Compartment ${index}`,
        content: `Summary ${index}`,
        p1: `Detailed narrative ${index}: ${"work continued on the module ".repeat(60)}`,
        p2: `Condensed ${index}`,
        p3: `Outcome ${index}`,
        p4: `Anchor ${index}`,
        importance: 50,
    };
}

function args(overrides: Partial<HistorianPromptFitArgs>): HistorianPromptFitArgs {
    return {
        window: { modelKey: MODEL, contextLimitTokens: 1_000_000, maxOutputTokens: 8_000 },
        systemPrompt: COMPARTMENT_AGENT_SYSTEM_PROMPT,
        requestedChunkTokens: 10_000,
        sessionId: "ses-fit",
        chunkStart: 61,
        lastOrdinal: 400,
        sessionCompartments: Array.from({ length: 6 }, (_, index) => compartment(index)),
        memories: Array.from({ length: 300 }, (_, index) => memory(index)),
        memoryEnabled: true,
        ...overrides,
    };
}

/** Calibrated size of the prompt a fit would send with a chunk of `chunkTokens`. */
function sentMass(input: HistorianPromptFitArgs, fit: ReturnType<typeof fitHistorianPrompt>) {
    if (!fit.ok) throw new Error(fit.reason);
    const user = buildCompartmentAgentPrompt({
        seedExamples: fit.seedExamples,
        sessionReferences: fit.sessionReferences,
        projectMemory: fit.projectMemory,
        inputSource: `Messages ${input.chunkStart}-${input.lastOrdinal}:\n\n`,
        memoryEnabled: input.memoryEnabled,
    });
    return providerMass(
        {
            prose: estimateTokens(user) + fit.chunkTokens,
            system: estimateTokens(input.systemPrompt),
        },
        calibrationForModelKey(input.window.modelKey),
        true,
    );
}

function limitOf(input: HistorianPromptFitArgs): number {
    const limit = producerInputTokenLimit(
        input.window.contextLimitTokens,
        input.window.maxOutputTokens,
        input.window.inputLimitTokens,
    );
    if (limit === undefined) throw new Error("window unknown");
    return limit;
}

describe("fitHistorianPrompt", () => {
    test("fit drops diverse examples before recent, and oldest recent first", () => {
        const input = args({
            memories: [],
            sessionCompartments: Array.from({ length: 12 }, (_, i) => compartment(i)),
        });
        const full = buildReferenceBlocks(input);
        const units = full.sessionReferences.match(/<compartment [\s\S]*?<\/compartment>/g) ?? [];
        expect(units).toHaveLength(7);
        for (const remaining of [6, 4, 3]) {
            const expected = `<session_references>\n${units.slice(-remaining).join("\n\n")}\n</session_references>`;
            const fixed = buildCompartmentAgentPrompt({
                seedExamples: full.seedExamples,
                sessionReferences: expected,
                projectMemory: "",
                inputSource: `Messages ${input.chunkStart}-${input.lastOrdinal}:\n\n`,
                memoryEnabled: true,
            });
            const inputLimitTokens = Math.ceil(
                providerMass(
                    {
                        system: estimateTokens(input.systemPrompt),
                        prose: estimateTokens(fixed) + input.requestedChunkTokens + 64,
                    },
                    calibrationForModelKey(MODEL),
                    true,
                ) /
                    (1 - PRODUCER_WINDOW_REFUSAL_MARGIN),
            );
            const fit = fitHistorianPrompt({
                ...input,
                window: { modelKey: MODEL, inputLimitTokens, maxOutputTokens: 8_000 },
            });
            if (!fit.ok) throw new Error(fit.reason);
            expect(fit.kept.sessionReferences).toBe(remaining);
            expect(fit.sessionReferences).toBe(expected);
            expect(fit.kept.seeds).toBe(3);
            for (let i = 12 - Math.min(4, remaining); i < 12; i++)
                expect(fit.sessionReferences).toContain(`title="Compartment ${i}"`);
            if (remaining === 3)
                expect(fit.sessionReferences).not.toContain('title="Compartment 8"');
        }
    });
    test("repeated fixed historian prompts reuse exact token counts without changing fit bytes", () => {
        const input = args({
            sessionId: "fit-token-reuse",
            systemPrompt: `${COMPARTMENT_AGENT_SYSTEM_PROMPT}\nunique-token-reuse`,
        });
        const first = fitHistorianPrompt(input);
        const estimate = spyOn(formatting, "estimateTokens");
        try {
            const repeated = fitHistorianPrompt(structuredClone(input));
            expect(estimate).toHaveBeenCalledTimes(0);
            expect(JSON.stringify(repeated)).toBe(JSON.stringify(first));
            const edited = fitHistorianPrompt({ ...input, systemPrompt: `${input.systemPrompt}!` });
            expect(estimate.mock.calls.length).toBeGreaterThan(0);
            expect(edited.ok).toBe(true);
        } finally {
            estimate.mockRestore();
        }
    });
    test("keeps every block and the requested chunk when the window has room", () => {
        const input = args({});
        const fit = fitHistorianPrompt(input);
        expect(fit.ok && fit.trimmed).toBe(false);
        expect(fit.ok && fit.chunkTokens).toBe(10_000);
        expect(fit.ok && fit.kept.memories).toBe(300);
        expect(sentMass(input, fit)).toBeLessThanOrEqual(limitOf(input));
    });

    test("trims recent compartments first, then memory lines, so the requested chunk fits", () => {
        // Large enough for the system prompt, seeds and the chunk, but not for the
        // 300-line memory block on top.
        const input = args({
            window: { modelKey: MODEL, contextLimitTokens: 80_000, maxOutputTokens: 8_000 },
        });
        const fit = fitHistorianPrompt(input);
        if (!fit.ok) throw new Error(fit.reason);
        expect(fit.chunkTokens).toBe(10_000);
        expect(fit.trimmed).toBe(true);
        expect(fit.kept.sessionReferences).toBe(0);
        expect(fit.kept.memories).toBeGreaterThan(0);
        expect(fit.kept.memories).toBeLessThan(300);
        expect(fit.kept.seeds).toBe(fit.kept.seedsTotal);
        expect(sentMass(input, fit)).toBeLessThanOrEqual(limitOf(input));
        // The kept lines are the highest-priority prefix of the full block.
        expect(fit.projectMemory).toContain("Fact 0:");
    });

    test("drops the seed examples and shrinks the chunk when nothing else is left", () => {
        // Only a few thousand tokens fit next to the system prompt.
        const input = args({
            window: { modelKey: MODEL, contextLimitTokens: 41_000, maxOutputTokens: 4_000 },
        });
        const fit = fitHistorianPrompt(input);
        if (!fit.ok) throw new Error(fit.reason);
        expect(fit.kept.memories).toBe(0);
        expect(fit.kept.sessionReferences).toBe(0);
        expect(fit.chunkTokens).toBeLessThan(10_000);
        expect(fit.chunkTokens).toBeGreaterThanOrEqual(1_000);
        expect(sentMass(input, fit)).toBeLessThanOrEqual(limitOf(input));
    });

    test("refuses with the same reason wherever the chunk starts when the fixed parts alone overflow", () => {
        const small = { modelKey: MODEL, contextLimitTokens: 16_000, maxOutputTokens: 4_000 };
        const early = fitHistorianPrompt(args({ window: small, chunkStart: 1, lastOrdinal: 9 }));
        const late = fitHistorianPrompt(
            args({ window: small, chunkStart: 12_345, lastOrdinal: 99_999, memories: [] }),
        );
        expect(early.ok).toBe(false);
        expect(late.ok).toBe(false);
        if (early.ok || late.ok) return;
        expect(early.reason).toContain("producer_prompt_unfit");
        expect(early.reason).toBe(late.reason);
        // A larger window is a different outcome, so a caller backing off on the
        // reason retries once the window changes.
        const larger = fitHistorianPrompt(
            args({ window: { ...small, contextLimitTokens: 1_000_000 } }),
        );
        expect(larger.ok).toBe(true);
    });

    test("sends the full prompt unguarded when the window is unknown", () => {
        const fit = fitHistorianPrompt(
            args({ window: { modelKey: MODEL, maxOutputTokens: 8_000 } }),
        );
        expect(fit.ok && fit.guarded).toBe(false);
        expect(fit.ok && fit.chunkTokens).toBe(10_000);
        expect(fit.ok && fit.kept.memories).toBe(300);
    });
});
