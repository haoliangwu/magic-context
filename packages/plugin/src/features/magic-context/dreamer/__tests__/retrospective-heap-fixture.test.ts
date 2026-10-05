import { expect } from "bun:test";
import { estimateTokens } from "../../../../hooks/magic-context/read-session-formatting";
import type { PluginContext } from "../../../../plugin/types";
import { Database } from "../../../../shared/sqlite";
import { runMigrations } from "../../migrations";
import { initializeDatabase } from "../../storage-db";
import type { RetrospectiveRawProvider } from "../retrospective-raw-provider";
import { createDreamTaskExecutor } from "../task-executor";
import { leaseKeyFor } from "../task-registry";

export async function measureRetrospective(provider: RetrospectiveRawProvider) {
    const db = new Database(":memory:");
    initializeDatabase(db);
    runMigrations(db);
    estimateTokens("Warm tokenizer before measuring historical reads.");
    Bun.gc(true);
    const before = process.memoryUsage().heapUsed;
    let peak = before;
    let parses = 0;
    let maxParsedChars = 0;
    let prompt = "";
    let deleted = false;
    const sample = () => {
        peak = Math.max(peak, process.memoryUsage().heapUsed);
    };
    const parse = JSON.parse;
    // Sample synchronous reads too; a timer misses transient JSON/SQLite hydration.
    JSON.parse = (...args: Parameters<typeof JSON.parse>) => {
        const value = parse(...args);
        maxParsedChars = Math.max(maxParsedChars, args[0].length);
        sample();
        parses++;
        return value;
    };
    const client = {
        session: {
            list: async () => ({ data: [{ id: "ses-parent", title: "ordinary session" }] }),
            create: async () => {
                sample();
                return { data: { id: "retro-child" } };
            },
            prompt: async (args: { body: { parts: Array<{ text: string }> } }) => {
                prompt = args.body.parts[0].text;
                sample();
                return { data: {} };
            },
            messages: async () => {
                sample();
                return {
                    data: [
                        {
                            info: { role: "assistant", finish: "stop" },
                            parts: [{ type: "text", text: "n" }],
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
            sessionDirectory: "/fixture/retro",
            openOpenCodeDb: () => null,
            retrospectiveRawProvider: provider,
            onProgress: sample,
        });
        const result = await executor(
            { task: "retrospective", schedule: "", timeoutMinutes: 1 },
            {
                db,
                projectIdentity: "git:retro-heap",
                holderId: "retro-holder",
                leaseKey: leaseKeyFor("retrospective", "git:retro-heap"),
            },
        );
        sample();
        expect(result.status).toBe("completed");
        expect(deleted).toBe(true);
        expect(prompt).toContain("question 1");
        expect(prompt).not.toContain("xxxxxxxxxx");
        expect(prompt.length).toBeLessThan(30_000);
        return {
            before,
            peak,
            delta: peak - before,
            parses,
            maxParsedChars,
            promptChars: prompt.length,
        };
    } finally {
        JSON.parse = parse;
        db.close();
    }
}

export function assertRetrospectiveHeap(
    small: Awaited<ReturnType<typeof measureRetrospective>>,
    large: typeof small,
) {
    console.log("[retrospective heap]", JSON.stringify({ small, large }));
    // Bun can leave SQLite-backed string storage out of heapUsed. Observe the
    // actual JSON crossing into JS as well, so a giant selected part cannot hide
    // behind an unchanged heap counter.
    expect(large.maxParsedChars).toBeLessThan(1024 * 1024);
    expect(large.delta).toBeLessThan(48 * 2 ** 20);
    expect(large.delta - small.delta).toBeLessThan(32 * 2 ** 20);
}
