/**
 * Isolated postprocess replay on a private clone of /tmp/ctx-bench.db and the
 * last 2,252 source messages from OpenCode's read-only store. No tagger timing
 * or provider serialization is included. The phase receives a fresh host array
 * each time, with the real persisted replay decisions and attribution rows.
 *
 * NODE_ENV=production bun packages/plugin/scripts/benchmark-postprocess-defer.ts
 * Optional: OPENCODE_DB_PATH, MC_BENCH_SESSION, MC_BENCH_MESSAGES.
 * The source fixture is not a captured post-tagger array: prefix injection and
 * auto-search are disabled to isolate replay, not simulate a full request.
 */
import { spyOn } from "bun:test";
import { createHash } from "node:crypto";
import { constants, copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { getActiveTagsBySession, getOrCreateSessionMeta } from "../src/features/magic-context/storage";
import { createTagger } from "../src/features/magic-context/tagger";
import type { Channel1State } from "../src/hooks/magic-context/ctx-reduce-nudge";
import type { MessageLike } from "../src/hooks/magic-context/tag-messages";
import { runPostTransformPhase } from "../src/hooks/magic-context/transform-postprocess-phase";
import * as logger from "../src/shared/logger";
import { Database } from "../src/shared/sqlite";
import { resolveOpenCodeDatabasePath } from "./context-dump/database-paths";
import { readOpenCodeSessionMessages } from "./context-dump/read-opencode-session";

const sessionId = process.env.MC_BENCH_SESSION ?? "ses_099ff1cb2ffeTSE956AjbUYyF3";
const count = Number(process.env.MC_BENCH_MESSAGES ?? 2252);
const temporary = mkdtempSync(join(process.cwd(), ".postprocess-profile-"));
const path = join(temporary, "context.db");
copyFileSync("/tmp/ctx-bench.db", path, constants.COPYFILE_FICLONE);
const db = new Database(path);
const timings: Record<string, number[]> = {};
const log = spyOn(logger, "sessionLog").mockImplementation((_session, ...values) => {
    for (const value of values) {
        if (typeof value !== "string") continue;
        const match = value.match(/stage=(\S+) elapsed=([\d.]+)ms/);
        if (match) (timings[match[1]] ??= []).push(Number(match[2]));
    }
});
try {
    const messages = readOpenCodeSessionMessages(resolveOpenCodeDatabasePath(), sessionId).slice(-count) as MessageLike[];
    const args: Parameters<typeof runPostTransformPhase>[0] = {
        sessionId,
        db,
        messages: [],
        tags: getActiveTagsBySession(db, sessionId),
        targets: new Map(),
        reasoningByMessage: new Map(),
        messageTagNumbers: new Map(),
        tagger: createTagger(),
        ctxReduceAvailability: { callable: true, frozen: true },
        todowriteAvailability: { callable: true, frozen: true },
        batch: null,
        contextUsage: { percentage: 65, inputTokens: 100_000 },
        usableWindow: 180_000,
        schedulerDecision: "defer",
        schedulerDeferReason: "scheduler_defer",
        fullFeatureMode: true,
        canRunCompartments: false,
        awaitedCompartmentRun: false,
        phaseJustAwaitedPublication: false,
        compartmentInProgress: false,
        historyRefreshExplicitBeforePrepare: false,
        deferredHistoryWasPendingAtPassStart: false,
        compartmentInjectionRebuiltFromDb: false,
        rebuiltHistoryFromInitialPrepare: false,
        historyRebuiltThisPass: false,
        canConsumeDeferredLate: false,
        sessionMeta: getOrCreateSessionMeta(db, sessionId),
        currentTurnId: null,
        pendingMaterializationSessions: new Set(),
        deferredHistoryRefreshSessions: new Set(),
        deferredMaterializationSessions: new Set(),
        lastHeuristicsTurnId: new Map(),
        clearReasoningAge: 999,
        protectedTagIds: new Set(),
        protectedTagNumbers: new Set(),
        protectedCutoff: null,
        protectedCount: 0,
        pendingCompartmentInjection: null,
        didMutateFromFlushedStatuses: false,
        watermark: 0,
        forceMaterializationPercentage: 85,
        hasRecentReduceCall: false,
        channel1StateBySession: new Map<string, Channel1State>(),
        resolvedProviderID: "anthropic",
    };
    const hashes: string[] = [];
    for (let pass = 0; pass < 25; pass += 1) {
        args.messages = structuredClone(messages);
        const start = performance.now();
        await runPostTransformPhase(args);
        (timings.total ??= []).push(performance.now() - start);
        if (pass >= 5 && pass < 9) hashes.push(createHash("sha256").update(JSON.stringify(args.messages)).digest("hex"));
    }
    const stages = Object.fromEntries(Object.entries(timings).map(([stage, values]) => {
        const warm = values.slice(5).sort((a, b) => a - b);
        return [stage, { cold: values[0], p50: warm[Math.floor(warm.length / 2)], max: Math.max(...warm) }];
    }));
    console.log(JSON.stringify({ sessionId, messages: messages.length, sourceBytes: JSON.stringify(messages).length, stages, deferHashes: hashes }, null, 2));
    if (new Set(hashes).size !== 1) throw new Error("Repeated defer phase changed served bytes");
    if (process.env.MC_PERF_GATE === "1" && stages.total.p50 >= 10) throw new Error("postprocess p50 exceeds 10ms");
} finally {
    log.mockRestore();
    db.close();
    rmSync(temporary, { recursive: true, force: true });
}
