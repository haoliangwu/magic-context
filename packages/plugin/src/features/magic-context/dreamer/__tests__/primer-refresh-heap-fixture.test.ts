import { expect, spyOn } from "bun:test";
import type { RawMessageProvider } from "../../../../hooks/magic-context/read-session-chunk";
import { estimateTokens } from "../../../../hooks/magic-context/read-session-formatting";
import type { PluginContext } from "../../../../plugin/types";
import { Database } from "../../../../shared/sqlite";
import { runMigrations } from "../../migrations";
import { initializeDatabase } from "../../storage-db";
import { createPrimer, getActivePrimers, insertPrimerCandidates } from "../../storage-primers";
import { createDreamTaskExecutor } from "../task-executor";
import { leaseKeyFor } from "../task-registry";

export async function measurePrimerRefresh(
    sessionId: string,
    messageCount: number,
    primerRawProviderFactory?: (id: string) => Promise<RawMessageProvider | null>,
) {
    const db = new Database(":memory:");
    initializeDatabase(db);
    runMigrations(db);
    const project = "git:primer-heap-fixture";
    const ids = insertPrimerCandidates(db, [
        {
            projectPath: project,
            harness: primerRawProviderFactory ? "pi" : "opencode",
            sessionId,
            question: "Where is the cache?",
            sourceCompartmentStart: 1,
            sourceCompartmentEnd: messageCount,
            sourceMessageTime: 1,
            sourceStartMessageId: "start",
            sourceEndMessageId: "end",
        },
    ]);
    createPrimer(db, {
        projectPath: project,
        question: "Where is the cache?",
        totalSupport: 1,
        lastObservedAt: 1,
        sourceCandidateIds: ids,
    });
    estimateTokens("Warm the tokenizer before measuring history-dependent allocations.");
    Bun.gc(true);
    const before = process.memoryUsage().heapUsed;
    let peak = before;
    let parses = 0;
    let prompt = "";
    let deleted = false;
    const sample = () => {
        peak = Math.max(peak, process.memoryUsage().heapUsed);
    };
    const parse = JSON.parse;
    // Timers cannot observe a synchronous SQLite/JSONL read. Sample while parsed
    // rows are still live, as well as at every asynchronous child-run boundary.
    const parseSpy = spyOn(JSON, "parse").mockImplementation(
        (...args: Parameters<typeof JSON.parse>) => {
            const value = parse(...args);
            if (++parses % 25 === 0) sample();
            return value;
        },
    );
    const client = {
        session: {
            list: async () => {
                sample();
                return { data: [{ id: "ses-parent", title: "ordinary session" }] };
            },
            create: async () => {
                sample();
                return { data: { id: "primer-child" } };
            },
            prompt: async (args: { body: { parts: Array<{ text: string }> } }) => {
                prompt = args.body.parts[0].text;
                sample();
                return { data: {} };
            },
            messages: async (args: { query: { limit: number } }) => {
                sample();
                expect(args.query.limit).toBe(100);
                return {
                    data: [
                        {
                            info: { role: "assistant", finish: "stop" },
                            parts: [
                                {
                                    type: "tool",
                                    tool: "read",
                                    callID: "grounding",
                                    state: {
                                        input: { filePath: "/src/cache.ts" },
                                        output: "x".repeat(16_384),
                                        status: "completed",
                                    },
                                },
                                {
                                    type: "text",
                                    text: '{"answer":"The cache is in src/cache.ts."}',
                                },
                            ],
                        },
                    ],
                };
            },
            delete: async () => {
                sample();
                deleted = true;
                return {};
            },
        },
    };
    try {
        const executor = createDreamTaskExecutor({
            client: client as unknown as PluginContext["client"],
            sessionDirectory: "/fixture/primer",
            openOpenCodeDb: () => null,
            primerRawProviderFactory,
            onProgress: sample,
        });
        const result = await executor(
            { task: "refresh-primers", schedule: "", timeoutMinutes: 1 },
            {
                db,
                projectIdentity: project,
                holderId: "heap-holder",
                leaseKey: leaseKeyFor("refresh-primers", project),
            },
        );
        sample();
        expect(result.status).toBe("completed");
        expect(getActivePrimers(db, project)[0].answer).toBe("The cache is in src/cache.ts.");
        expect(deleted).toBe(true);
        expect(prompt).toContain("U: question 1");
        expect(prompt).toContain("TC: read(/src/File1.kt)");
        expect(prompt).not.toContain("Unresolved reference");
        expect(prompt).not.toContain("xxxxxxxxxx");
        expect(prompt.length).toBeLessThan(30_000);
        return { before, peak, delta: peak - before, promptChars: prompt.length, parses };
    } finally {
        parseSpy.mockRestore();
        db.close();
    }
}

export function assertBoundedHeap(
    small: Awaited<ReturnType<typeof measurePrimerRefresh>>,
    large: typeof small,
) {
    console.log("[primer-refresh heap]", JSON.stringify({ small, large }));
    expect(large.delta).toBeLessThan(48 * 2 ** 20);
    expect(large.delta - small.delta).toBeLessThan(32 * 2 ** 20);
}
