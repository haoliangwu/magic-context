import { expect, spyOn, test } from "bun:test";
import { runMigrations } from "../../features/magic-context/migrations";
import { createScheduler } from "../../features/magic-context/scheduler";
import { getOrCreateSessionMeta } from "../../features/magic-context/storage";
import { initializeDatabase } from "../../features/magic-context/storage-db";
import { createTagger } from "../../features/magic-context/tagger";
import { Database } from "../../shared/sqlite";
import { closeQuietly } from "../../shared/sqlite-helpers";
import type { MessageLike } from "./tag-messages";
import { createTransform } from "./transform";
import * as postprocess from "./transform-postprocess-phase";

// The transform's stages count canonical ordinals synchronously. On the first
// pass of a session the summary scan those counts need runs on a worker, and
// the pass must wait for it before any stage runs, so no stage scans the
// session on the serving thread.
test("a transform pass waits for the canonical ordinal warm-up before its stages run", async () => {
    const db = new Database(":memory:");
    initializeDatabase(db);
    runMigrations(db);
    const sessionId = "ses-warmup-transform";
    getOrCreateSessionMeta(db, sessionId);
    let release: (ready: boolean) => void = () => {};
    const prepared: string[] = [];
    const transform = createTransform({
        db,
        tagger: createTagger(),
        scheduler: createScheduler({ executeThresholdPercentage: 65 }),
        contextUsageMap: new Map(),
        protectedTokens: 0,
        historyRefreshSessions: new Set(),
        pendingMaterializationSessions: new Set(),
        lastHeuristicsTurnId: new Map(),
        hostPrepareRawOrdinals: (session) => {
            prepared.push(session);
            return new Promise<boolean>((resolve) => {
                release = resolve;
            });
        },
    });
    const stages = spyOn(postprocess, "runPostTransformPhase");
    try {
        const messages: MessageLike[] = [
            {
                info: { id: "u", role: "user", sessionID: sessionId },
                parts: [{ type: "text", text: "task" }],
            },
        ];
        const pass = transform({}, { messages });
        await Bun.sleep(50);
        expect(prepared).toEqual([sessionId]);
        expect(stages).not.toHaveBeenCalled();
        // A failed warm-up still serves the pass.
        release(false);
        await pass;
        expect(stages).toHaveBeenCalledTimes(1);
    } finally {
        stages.mockRestore();
        closeQuietly(db);
    }
});
