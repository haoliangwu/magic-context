/// <reference types="bun-types" />
// Places where an OpenCode 2 instruction row (an id-less `system` message) that
// the history boundary covers must be handled the same way on every pass, so
// one pass cannot serve it while the next drops it (or the reverse).

import { afterEach, beforeEach, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendCompartments } from "../../features/magic-context/compartment-storage";
import { closeDatabase, openDatabase } from "../../features/magic-context/storage";
import { createTestTempDirFromPath } from "../../shared/test-temp-dir";
import { registerActiveCompartmentRun } from "./compartment-runner";
import { isHostRenderedSystemMessage } from "./host-served-rows";
import { prepareCompartmentInjection } from "./inject-compartments";
import { runCompartmentPhase } from "./transform-compartment-phase";

let tempDir: string | undefined;
const originalXdgDataHome = process.env.XDG_DATA_HOME;

beforeEach(() => {
    tempDir = createTestTempDirFromPath(join(tmpdir(), "mc-issue-750-cache-review-"));
    process.env.XDG_DATA_HOME = tempDir;
});

afterEach(() => {
    closeDatabase();
    if (originalXdgDataHome === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = originalXdgDataHome;
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
});

// At 95% context the transform waits for a running historian and, when the
// run published history that a deferred refresh is waiting on, prepares the
// history injection a second time (transform-compartment-phase.ts,
// awaitCompartmentRun). That second preparation must add the covered OpenCode 2
// instruction rows it cuts to the pass's set-aside list, the same list the
// first preparation uses, so postprocess decides about them exactly as the next
// pass (which cuts at the same boundary in its first preparation) will.
test("historian inline-join re-preparation sets a covered OpenCode 2 instruction row aside", async () => {
    const sessionId = "ses-750-review-inline-join";
    const db = openDatabase();
    if (!db) throw new Error("isolated database unavailable");
    let finishHistorian!: () => void;
    const activeRun = registerActiveCompartmentRun(
        sessionId,
        new Promise<void>((resolve) => {
            finishHistorian = resolve;
        }),
    );
    appendCompartments(db, sessionId, [
        {
            sequence: 0,
            startMessage: 1,
            endMessage: 3,
            startMessageId: "m1",
            endMessageId: "m2",
            title: "Inline fold",
            content: "The historian completed within the inline join budget.",
        },
    ]);
    activeRun.published = true;
    const instruction = {
        info: { role: "system" },
        parts: [{ type: "text", text: "Today's date is now: day 2." }],
    };
    const input = [
        { info: { id: "m1", role: "user" }, parts: [{ type: "text", text: "start" }] },
        instruction,
        { info: { id: "m2", role: "assistant" }, parts: [{ type: "text", text: "done" }] },
        { info: { id: "m3", role: "user" }, parts: [{ type: "text", text: "next" }] },
    ];
    const messages = [...input];
    const setAside: unknown[] = [];
    expect(isHostRenderedSystemMessage(instruction as never)).toBe(true);
    const pass = runCompartmentPhase({
        canRunCompartments: true,
        fullFeatureMode: true,
        sessionMeta: { compartmentInProgress: true },
        contextUsage: { percentage: 97 },
        boundaryContextLimit: 100_000,
        boundaryExecuteThresholdPercentage: 65,
        boundaryUsage: { percentage: 97, inputTokens: 97_000 },
        boundaryUsageSource: "live",
        db,
        sessionId,
        resolvedSessionId: sessionId,
        historianChunkTokens: 25_000,
        historianTimeoutMs: 600_000,
        skipAwaitForThisPass: true,
        compartmentDirectory: "/tmp",
        messages: messages as never,
        coveredInstructions: setAside as never,
        pendingCompartmentInjection: null,
        deferredHistoryRefreshSessions: new Set([sessionId]),
    });
    finishHistorian();
    const result = await pass;
    expect(result.awaitedCompartmentRun).toBe(true);
    expect(result.pendingCompartmentInjection?.block).toContain("Inline fold");
    // The next pass's history preparation replays this boundary and sets the
    // instruction row aside, so that pass serves it (retention switch on).
    const nextPassSetAside: unknown[] = [];
    prepareCompartmentInjection(
        db,
        sessionId,
        structuredClone(input) as never,
        false,
        nextPassSetAside as never,
    );
    expect(nextPassSetAside).toHaveLength(1);
    // This pass cut the covered rows and set the same instruction row aside,
    // so postprocess serves it (or drops it) exactly as the next pass will.
    expect(messages.map((message) => message.info.id ?? "instruction")).toEqual(["m3"]);
    expect(setAside).toEqual([instruction]);
});
