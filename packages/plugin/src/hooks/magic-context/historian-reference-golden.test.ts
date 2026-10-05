import { expect, test } from "bun:test";
import golden from "../../../../../crates/mc-module/testdata/historian-prompt-golden.json";
import type { Memory } from "../../features/magic-context/memory/types";
import { buildCompartmentAgentPrompt } from "./compartment-prompt";
import { renderHistorianMemoryBlock } from "./inject-compartments";
import {
    buildReferenceBlocks,
    type ReferenceCompartment,
    renderSeedExamplesBlock,
    renderSessionReferencesBlock,
    selectSeeds,
    selectSessionReferences,
} from "./reference-retrieval";
import { REFERENCE_SEEDS } from "./reference-seeds.generated";

function compartment(c: {
    start_message: number;
    end_message: number;
    title: string;
    content: string;
    p1?: string | null;
    p2?: string | null;
    p3?: string | null;
    p4?: string | null;
    importance?: number | null;
    episode_type?: string | null;
}): ReferenceCompartment {
    return {
        startMessage: c.start_message,
        endMessage: c.end_message,
        title: c.title,
        content: c.content,
        p1: c.p1,
        p2: c.p2,
        p3: c.p3,
        p4: c.p4,
        importance: c.importance,
        episodeType: c.episode_type,
    };
}

test("historian rendered blocks match the shared Rust golden", () => {
    expect(golden.reference_cases).toHaveLength(11);
    for (const c of golden.seed_cases) {
        const seeds = selectSeeds(c.session_id, c.chunk_start, c.count);
        expect(seeds.map((s) => REFERENCE_SEEDS.indexOf(s))).toEqual(c.selected_indices);
        expect(renderSeedExamplesBlock(seeds)).toBe(c.seed_examples);
    }
    for (const c of golden.reference_cases) {
        const seeds = selectSeeds(c.session_id, c.chunk_start);
        const selected = selectSessionReferences(
            c.session_compartments.map(compartment),
            seeds,
            c.session_id,
            c.chunk_start,
        );
        expect(selected.map((r) => r.startMessage)).toEqual(c.selected_starts);
        expect(renderSeedExamplesBlock(seeds)).toBe(c.seed_examples);
        for (const w of c.windows)
            expect(renderSessionReferencesBlock(selected, w.window)).toBe(w.block);
    }
    for (const c of golden.prompt_cases) {
        const refs = buildReferenceBlocks({
            sessionId: c.session_id,
            chunkStart: c.chunk_start,
            sessionCompartments: c.session_compartments.map(compartment),
        });
        expect(refs.seedExamples).toBe(c.seed_examples);
        expect(refs.sessionReferences).toBe(c.session_references);
        const projectMemory = renderHistorianMemoryBlock(c.memories as Memory[]) ?? "";
        expect(projectMemory).toBe(c.project_memory);
        expect(
            buildCompartmentAgentPrompt({
                ...refs,
                projectMemory,
                inputSource: c.input_source,
                memoryEnabled: c.memory_enabled,
                extractionFree: c.extraction_free,
            }),
        ).toBe(c.prompt);
    }
});
