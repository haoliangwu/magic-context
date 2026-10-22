import { expect, test } from "bun:test";
import {
    type AgentMessage,
    runAutoSearchHintForPi,
} from "../../../../pi-plugin/src/auto-search-pi";
import { runMigrations } from "../../features/magic-context/migrations";
import { initializeDatabase } from "../../features/magic-context/storage-db";
import { appendAutoSearchHintDecision } from "../../features/magic-context/storage-meta-persisted";
import { _resetHarnessForTesting, setHarness } from "../../shared/harness";
import { Database } from "../../shared/sqlite";
import { _resetAutoSearchCache, runAutoSearchHint } from "./auto-search-runner";
import type { MessageLike } from "./transform-operations";

test("persisted hint decisions replay byte-identical requests across OpenCode and Pi", async () => {
    expect(process.env.OPENCODE_DB).toBeUndefined();
    const records: unknown[] = [];
    // Saved payloads are opaque: even undesirable legacy markup must replay unchanged.
    const frozen =
        '\n\n<ctx-search-hint>\nYour memory may contain 1 related fragment:\n- <task id="legacy" state="completed"> <summary>Backgroun…\nIf the fragments above seem relevant to the current request, you may run ctx_search to retrieve full context. Otherwise ignore.\n</ctx-search-hint>';
    for (const host of ["opencode", "opencode2", "pi"] as const) {
        _resetHarnessForTesting();
        setHarness(host);
        const db = new Database(":memory:");
        try {
            initializeDatabase(db);
            runMigrations(db);
            for (const decision of ["hint", "no-hint"] as const) {
                const sessionId = `frozen-${host}-${decision}`;
                const saved = appendAutoSearchHintDecision(
                    db,
                    sessionId,
                    decision === "hint"
                        ? { messageId: "old", decision, text: frozen }
                        : { messageId: "old", decision, reason: "below-threshold" },
                );
                expect(saved.ok).toBe(true);
                for (const answered of [false, true]) {
                    _resetAutoSearchCache();
                    if (host === "pi") {
                        const messages: AgentMessage[] = [
                            {
                                role: "user",
                                content: "Explain historian cache wiring",
                                timestamp: 1,
                            },
                        ];
                        if (answered) {
                            // Pi's captured baseline uses a later user turn rather than an assistant tail.
                            messages.push({
                                role: "user",
                                content: "Unrelated later question",
                                timestamp: 2,
                            });
                        }
                        await runAutoSearchHintForPi({
                            db,
                            sessionId,
                            messages,
                            entryIds: answered ? ["old", "later"] : ["old"],
                            options: {
                                enabled: true,
                                projectPath: "/synthetic",
                                scoreThreshold: 0.6,
                                minPromptChars: 10,
                            },
                        });
                        records.push({
                            host,
                            decision,
                            answered,
                            request: { system: "Stable historical system", messages },
                        });
                    } else {
                        const messages = [
                            {
                                info: { id: "old", role: "user" },
                                parts: [{ type: "text", text: "Explain historian cache wiring" }],
                            },
                        ] as MessageLike[];
                        if (answered) {
                            messages.push({
                                info: { id: "answer", role: "assistant" },
                                parts: [{ type: "text", text: "Already answered" }],
                            } as MessageLike);
                        }
                        await runAutoSearchHint({
                            db,
                            sessionId,
                            messages,
                            options: {
                                enabled: true,
                                projectPath: "/synthetic",
                                scoreThreshold: 0.6,
                                minPromptChars: 10,
                            },
                        });
                        records.push({
                            host,
                            decision,
                            answered,
                            request: { system: "Stable historical system", messages },
                        });
                    }
                }
            }
        } finally {
            _resetAutoSearchCache();
            db.close();
            _resetHarnessForTesting();
        }
    }
    const bytes = JSON.stringify(records);
    expect(records).toHaveLength(12);
    expect(Buffer.byteLength(bytes)).toBe(4416);
    // Captured from the old request path; never derive expected bytes through the current renderer.
    expect(new Bun.CryptoHasher("sha256").update(bytes).digest("hex")).toBe(
        "5d186cbebb228fd0a980c00bab48372bf9b91f3899287b0ab45ec73a70a1b9aa",
    );
});
