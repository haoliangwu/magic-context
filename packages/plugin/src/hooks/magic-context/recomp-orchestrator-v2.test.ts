/// <reference types="bun-types" />

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
    appendCompartments,
    getCompartments,
} from "../../features/magic-context/compartment-storage";
import { initializeDatabase } from "../../features/magic-context/storage-db";
import { _resetHarnessForTesting, setHarness } from "../../shared/harness";
import { Database } from "../../shared/sqlite";
import { closeQuietly } from "../../shared/sqlite-helpers";
import type { HiddenCompletionExecutor } from "./compartment-runner-types";
import { createLiveSessionState } from "./live-session-state";
import { setRawMessageProvider } from "./read-session-chunk";
import { type ManagedRecompContext, runManagedRecomp } from "./recomp-orchestrator";

// OpenCode 2 gives a plugin no SDK client. Recomp used to reach for one
// (`client.session.get`) and never passed the historian the hidden-completion
// executor that host provides, so every run failed with MC-R01.

function executorCoveringRequestedRange(): HiddenCompletionExecutor & { opened: string[] } {
    const opened: string[] = [];
    let prompt = "";
    return {
        opened,
        capabilities: { tools: false, harness: "opencode" },
        open: async (run) => {
            opened.push(run.kind);
            return { id: `child-${opened.length}`, childSessionId: `child-${opened.length}` };
        },
        attempt: async (_handle, request) => {
            prompt = JSON.stringify(request);
        },
        collect: async () => {
            const range = prompt.match(/Messages (\d+)-(\d+):/);
            if (!range) throw new Error("historian prompt carried no message range");
            return {
                text: `<output><compartment start="${range[1]}" end="${range[2]}" title="Rebuilt"><p1>Rebuilt ${range[1]}-${range[2]}.</p1></compartment></output>`,
                reasoning: null,
                lengthCapped: false,
                usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            };
        },
        close: async () => {},
    };
}

function context(db: Database, executor: HiddenCompletionExecutor): ManagedRecompContext {
    return {
        client: undefined as never,
        hiddenCompletionExecutor: executor,
        db,
        liveSessionState: createLiveSessionState(),
        directory: "/tmp/project",
        historianChunkTokens: 10_000,
        historianTimeoutMs: 1_000,
        memoryEnabled: false,
        autoPromote: false,
        fallbackModels: [],
        userMemoriesEnabled: false,
        getNotificationParams: () => ({}),
    };
}

async function withMessages<T>(
    sessionId: string,
    count: number,
    run: () => Promise<T>,
): Promise<T> {
    const raw = Array.from({ length: count }, (_, index) => ({
        ordinal: index + 1,
        id: `m-${index + 1}`,
        role: "user",
        parts: [{ type: "text", text: `message ${index + 1} alpha beta gamma delta` }],
    }));
    const unregister = setRawMessageProvider(sessionId, {
        readMessages: () => raw,
        getMessageCount: () => raw.length,
    });
    try {
        return await run();
    } finally {
        unregister();
    }
}

describe("runManagedRecomp without an OpenCode 1 client", () => {
    // The OpenCode 2 harness owns its own compaction rows, so publication does
    // not write the OpenCode 1 marker; the test runs as that harness.
    beforeEach(() => setHarness("opencode2"));
    afterEach(() => _resetHarnessForTesting());

    it("rebuilds the whole history through the hidden executor", async () => {
        const db = new Database(":memory:");
        initializeDatabase(db);
        const sessionId = "ses-recomp-v2-full";
        const executor = executorCoveringRequestedRange();
        try {
            const message = await withMessages(sessionId, 6, () =>
                runManagedRecomp(context(db, executor), sessionId),
            );
            expect(message).toContain("## Magic Recomp — Complete");
            expect(message).not.toContain("MC-R01");
            expect(executor.opened.length).toBeGreaterThan(0);
            expect(getCompartments(db, sessionId).at(-1)?.content).toContain("Rebuilt");
        } finally {
            closeQuietly(db);
        }
    });

    it("rebuilds a range through the hidden executor", async () => {
        const db = new Database(":memory:");
        initializeDatabase(db);
        const sessionId = "ses-recomp-v2-partial";
        appendCompartments(
            db,
            sessionId,
            [
                [1, 3],
                [4, 6],
            ].map(([start, end], sequence) => ({
                sequence,
                startMessage: start as number,
                endMessage: end as number,
                startMessageId: `m-${start}`,
                endMessageId: `m-${end}`,
                title: `Original ${start}-${end}`,
                content: `Original ${start}-${end}`,
            })),
        );
        const executor = executorCoveringRequestedRange();
        try {
            const message = await withMessages(sessionId, 8, () =>
                runManagedRecomp(context(db, executor), sessionId, { range: { start: 1, end: 3 } }),
            );
            expect(message).not.toContain("MC-R01");
            expect(executor.opened.length).toBeGreaterThan(0);
            expect(getCompartments(db, sessionId).map((row) => row.title)).toEqual([
                "Rebuilt",
                "Original 4-6",
            ]);
        } finally {
            closeQuietly(db);
        }
    });
});
