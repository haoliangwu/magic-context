import { expect, test } from "bun:test";
import { buildCuratePrompt, type CuratePromptMemory, chunkCurateMemories } from "./task-prompts";

const memory = (id: number, content: string): CuratePromptMemory => ({
    id,
    category: "PROJECT_RULES",
    content,
    importance: 90,
    retrievalCount: 2,
    seenCount: 3,
    mappedFiles: ["src/core.ts"],
    hasNoFileSentinel: false,
});

test("curate snapshot includes decision fields and splits oversized categories with cross-chunk candidates", () => {
    const memories = [
        memory(1, "Keep the rule"),
        memory(2, "A distinct rule"),
        memory(3, "keep the rule"),
    ];
    const chunks = chunkCurateMemories(memories, 110);
    expect(chunks.length).toBe(3);
    expect(chunks[0].crossChunkCandidates).toEqual(["IDs 1, 3"]);
    expect(chunks[1].crossChunkCandidates).toEqual([]);
    for (const chunk of chunks) {
        const prompt = buildCuratePrompt({
            projectPath: "/repo",
            category: "PROJECT_RULES",
            ...chunk,
        });
        expect(prompt).toContain("Category snapshot");
        expect(prompt).toContain("importance=90 retrieval_count=2 seen_count=3");
        expect(prompt).toContain("src/core.ts");
        expect(prompt).not.toContain("ctx_memory_list");
    }
});
