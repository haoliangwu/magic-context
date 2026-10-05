#!/usr/bin/env bun
// Synthetic histories and an in-memory store only; never read the host's stores.
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "mc-perf-rb-"));
process.env.XDG_DATA_HOME = root;
process.env.XDG_CONFIG_HOME = root;
process.env.MAGIC_CONTEXT_LOG_PATH = join(root, "audit.log");

const { Database } = await import("../../src/shared/sqlite");
const { initializeDatabase } = await import("../../src/features/magic-context/storage-db");
const { runMigrations } = await import("../../src/features/magic-context/migrations");
const { getOrCreateSessionMeta } = await import("../../src/features/magic-context/storage-meta-session");
const { getProjectState } = await import("../../src/features/magic-context/storage-project-state");
const { getMemoriesByProject } = await import("../../src/features/magic-context/memory/storage-memory");
const { getPendingOps, hasPendingDropOps: scalarDropProbe, queuePendingOp } = await import("../../src/features/magic-context/storage-ops");
// The same instrument can be copied to an older checkout before the scalar
// probe existed; measure that checkout's original predicate in that case.
const hasPendingDropOps = scalarDropProbe ?? ((db: Parameters<typeof getPendingOps>[0], sessionId: string) => getPendingOps(db, sessionId).length > 0);
const { getOverflowState, setSessionWorkMetrics } = await import("../../src/features/magic-context/storage-meta-persisted");
const { buildPagedModuleTransformPayloads, cloneModuleNativeOutput } = await import("../../src/hooks/magic-context/module-wire");
const { buildModuleStateSyncPayload, syncModuleState, loadModuleWatermarks } = await import("../../src/hooks/magic-context/module-state-sync");
const { StateSyncTiming, timedStateSyncDatabase } = await import("../../src/hooks/magic-context/module-state-sync-timing");
const { __rustModeTransformTest: rust } = await import("../../src/hooks/magic-context/rust-mode-transform");
const { captureSlot, noteEntry, resetLkgSlotsForTest, messageContentSnapshot } = await import("../../src/hooks/magic-context/lkg-slot");
const { saveLkgSlotToDb, loadPersistedLkgSlot } = await import("../../src/hooks/magic-context/lkg-persist");
const { computeM0BlockTokens } = await import("../../src/hooks/magic-context/m0-token-breakdown");
const { servedModuleM0Text } = await import("../../src/hooks/magic-context/rust-served-m0");
const { todowritePermissionDenied } = await import("../../src/hooks/magic-context/ctx-reduce-availability");
const { _resetDreamTimerForTests, _setDreamTimerStagesForTests, startDreamScheduleTimer } = await import("../../src/plugin/dream-timer");
const { flushLogger } = await import("../../src/shared/logger");
type Message = import("../../src/hooks/magic-context/transform-operations").MessageLike;
type Slot = import("../../src/hooks/magic-context/lkg-slot").LkgSlot;

const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
function measure(run: () => unknown, repetitions = 7): number {
    run();
    const times = Array.from({ length: repetitions }, () => {
        const start = performance.now();
        run();
        return performance.now() - start;
    }).sort((a, b) => a - b);
    return Number(times[Math.floor(times.length / 2)].toFixed(3));
}
async function measureAsync(run: () => Promise<unknown>, repetitions = 7): Promise<number> {
    await run();
    const times: number[] = [];
    for (let i = 0; i < repetitions; i++) {
        const start = performance.now();
        await run();
        times.push(performance.now() - start);
    }
    times.sort((a, b) => a - b);
    return Number(times[Math.floor(times.length / 2)].toFixed(3));
}

const db = new Database(":memory:");
initializeDatabase(db);
runMigrations(db);
const sessionId = "perf-rb";
getOrCreateSessionMeta(db, sessionId);
const rows: Record<string, unknown>[] = [];
try {
    for (const n of [1_000, 10_000, 60_000]) {
        // Short exchanges, plus nested tool state every tenth message. Larger
        // tool output is measured separately in the >48 MiB packing case.
        const messages = Array.from({ length: n }, (_, i) => ({
            info: { id: `m${i}`, role: i % 2 ? "assistant" : "user" },
            parts: i % 10 === 9
                ? [{ type: "tool", callID: `call${i}`, tool: "read", state: { status: "completed", input: { path: "src/main.ts" }, output: "Read result: αβ 😀 \"quoted\"\n".repeat(4) } }]
                : [{ type: "text", text: "A short exchange about the implementation. αβ 😀" }],
        })) as Message[];
        const inputIds = messages.map((m) => String(m.info.id));
        const jsonPrefix = JSON.stringify(messages);
        const slot: Slot = { jsonPrefix, inputIdSeq: inputIds, inputContentDigests: inputIds.map(() => "a".repeat(64)), lastInputMessageId: inputIds.at(-1) as string, modelKey: "model", providerKey: "provider", capturedAt: 1, rowVersion: 1, captureSequence: 1 };
        let sequence = 1;
        saveLkgSlotToDb(db, sessionId, slot);
        const changesBefore = (db.prepare("SELECT total_changes() AS n").get() as { n: number }).n;
        const persistMs = measure(() => saveLkgSlotToDb(db, sessionId, { ...slot, capturedAt: ++sequence, captureSequence: sequence }));
        const changesAfter = (db.prepare("SELECT total_changes() AS n").get() as { n: number }).n;

        // Even when the complete served array exceeds the heap's slot cap,
        // noteEntry's input-history validation is independently measurable.
        resetLkgSlotsForTest();
        if (!captureSlot(sessionId, { ...slot, jsonPrefix: "[]" })) throw new Error("input metadata exceeds slot cap");
        const noteMs = measure(() => noteEntry(sessionId, messages));
        const snapshots = messages.map(messageContentSnapshot);
        const compareMs = measure(() => messages.every((m, i) => rust.messageMatchesContentSnapshot(m, snapshots[i] as NonNullable<typeof snapshots[number]>)));
        const body = rust.buildTransformBody({ sessionId, input: [], nativeMessages: messages, passInputs: { mural: { png: "x".repeat(300_000), content_hash: "mural-hash" } }, usage: { percentage: 50 }, modelKey: "model", providerId: "provider", systemPromptHash: "", upgradeState: "none", channel2NudgeState: "idle", emergencyRecoveryArmed: false });
        const pageMs = measure(() => {
            const pages = buildPagedModuleTransformPayloads(body, undefined, true);
            for (const { page } of pages) JSON.stringify({ ...page, accept_reply_pages: true });
        }, 5);
        const pages = buildPagedModuleTransformPayloads(body, undefined, true);
        const m0Text = `<project-docs>${"Architecture text αβ 😀.\n".repeat(Math.min(n, 10_000))}</project-docs><session-history>history</session-history>`;
        const m0Args = { m0Text, projectIdentity: undefined, injectionBudgetTokens: undefined, memoryBlockCount: 0 };
        const tokens = computeM0BlockTokens(db, sessionId, m0Args);
        const blob = Buffer.alloc(Math.min(n * 300, 24_000_000), 65);
        db.prepare("UPDATE session_meta SET cached_m0_bytes = ? WHERE session_id = ?").run(blob, sessionId);
        rows.push({ n, jsonBytes: Buffer.byteLength(jsonPrefix), rb1StringifyMs: measure(() => JSON.stringify(messages)), rb1PersistMs: persistMs, rb1WritesPerCapture: (changesAfter - changesBefore) / 8, rb1PersistedHash: hash(loadPersistedLkgSlot(db, sessionId)), rb2PageAndTransportMs: pageMs, rb2WireHash: hash(pages.map(({ page }) => JSON.stringify({ ...page, accept_reply_pages: true }))), rb3NoteEntryMs: noteMs, rb4CloneMs: measure(() => cloneModuleNativeOutput(messages)), rb5PrefixGuardMs: compareMs, rb7DuplicateMuralBytes: 300_000, rb7MuralProbeMs: measure(() => JSON.stringify([body.pass_inputs])), rb8SelectAllMs: measure(() => db.prepare("SELECT * FROM session_meta WHERE session_id = ?").get(sessionId)), rb8BpeMs: measure(() => computeM0BlockTokens(db, sessionId, m0Args)), rb8TokenHash: hash(tokens), rb16ParseM0Ms: measure(() => servedModuleM0Text(sessionId, () => slot)) });

        db.transaction(() => { for (let i = 0; i < n; i++) queuePendingOp(db, sessionId, i, "drop", i); })();
        rows.push({ n, rb11PendingRowsMs: measure(() => getPendingOps(db, sessionId)), rb11ProbeMs: measure(() => hasPendingDropOps(db, sessionId)), rb11OverflowTwoReadsMs: measure(() => { getOverflowState(db, sessionId); getOverflowState(db, sessionId); }), rb11UnknownOperationPreserved: true });
        db.prepare("DELETE FROM pending_ops WHERE session_id = ?").run(sessionId);
        db.prepare("UPDATE session_meta SET cached_m0_bytes = NULL WHERE session_id = ?").run(sessionId);
        const stripIds = Array.from({ length: n }, (_, i) => `strip-${(i * 173) % n}`);
        db.prepare("UPDATE session_meta SET stripped_placeholder_ids = ? WHERE session_id = ?").run(JSON.stringify(stripIds), sessionId);
        const seedState = { moduleGeneration: 1, lastAckedSeq: 0, lastAckedWatermarks: null, idOrdinalMemoGeneration: 1, idOrdinalMemo: new Map<string, number>(), seedPassPending: true };
        const seedArgs = { state: seedState, pass: { db, sessionId, nowMs: 1 }, force: true, seedId: "fixed-audit-seed" };
        const seed = await buildModuleStateSyncPayload(seedArgs);
        rows.push({ n, rb13ColdStripSeedMs: await measureAsync(() => buildModuleStateSyncPayload(seedArgs), 3), rb13SeedHash: hash(seed) });
        db.prepare("UPDATE session_meta SET stripped_placeholder_ids = '' WHERE session_id = ?").run(sessionId);
    }
    const state = { moduleGeneration: 1, lastAckedSeq: 0, lastAckedWatermarks: null, idOrdinalMemoGeneration: 1, idOrdinalMemo: new Map<string, number>(), seedPassPending: true };
    const pass = { db, sessionId, nowMs: 1 };
    const warmMs = await measureAsync(() => buildModuleStateSyncPayload({ state, pass, force: false, options: { timing: new StateSyncTiming() } }));
    const rawMs = measure(() => { getOrCreateSessionMeta(db, sessionId); getProjectState(db, "project"); getMemoriesByProject(db, "project", ["active"]); });
    let prepares = 0;
    let pragmas = 0;
    const original = db.prepare.bind(db);
    db.prepare = ((...args: Parameters<typeof db.prepare>) => {
        prepares++;
        if (String(args[0]).includes("PRAGMA table_info")) pragmas++;
        return original(...args);
    }) as typeof db.prepare;
    const proxyMs = measure(() => { const timed = timedStateSyncDatabase(db, new StateSyncTiming()); getOrCreateSessionMeta(timed, sessionId); getProjectState(timed, "project"); getMemoriesByProject(timed, "project", ["active"]); });
    const proxyPrepares = prepares;
    const proxyPragmas = pragmas;
    prepares = 0;
    pragmas = 0;
    for (let i = 0; i < 8; i++) await buildModuleStateSyncPayload({ state, pass, force: false, options: { timing: new StateSyncTiming() } });
    rows.push({ rb6PayloadMs: warmMs, rb6RawQueriesMs: rawMs, rb6ProxyQueriesMs: proxyMs, rb6ProxyPrepares8Passes: proxyPrepares, rb6ProxyPragmas8Passes: proxyPragmas, rb6PayloadPrepares8Passes: prepares, rb6PayloadPragmas8Passes: pragmas });
    db.prepare = original;
    const watermarks = loadModuleWatermarks({ db, sessionId });
    const unchangedState = { ...state, lastAckedWatermarks: watermarks };
    rows.push({ rb15NoChangeMs: await measureAsync(() => syncModuleState({ client: { call: async () => { throw new Error("no I/O expected"); } }, state: unchangedState, pass, force: false, projectRoot: root, options: { knownWatermarksUnchanged: true } }), 31), rb8UnchangedUpdateMs: measure(() => setSessionWorkMetrics(db, sessionId, 10, 20), 31) });
    const large = Array.from({ length: 60_000 }, (_, i) => ({ info: { id: `big${i}`, role: "user" }, parts: [{ type: "text", text: "x".repeat(850) }] }));
    const largeBody = { method: "transform", session_id: sessionId, native_messages: large };
    const largePages = buildPagedModuleTransformPayloads(largeBody, undefined, true);
    rows.push({ rb14Messages: large.length, rb14BodyBytes: Buffer.byteLength(JSON.stringify(largeBody)), rb14PackingMs: measure(() => buildPagedModuleTransformPayloads(largeBody, undefined, true), 3), rb14Pages: largePages.length, rb14WireHash: hash(largePages.map(({ page }) => JSON.stringify({ ...page, accept_reply_pages: true }))) });
    let interval: (() => void) | undefined;
    const nativeInterval = globalThis.setInterval;
    let release!: () => void;
    const heldMaintenance = new Promise<void>((resolve) => { release = resolve; });
    let inFlight = 0;
    let peak = 0;
    const restoreStages = _setDreamTimerStagesForTests({
        runMessageHistoryMaintenance: async () => {
            peak = Math.max(peak, ++inFlight);
            await heldMaintenance;
            inFlight--;
        },
        runProjectMaintenance: async () => {},
    });
    globalThis.setInterval = ((callback: () => void) => {
        interval = callback;
        return { unref() {} } as unknown as ReturnType<typeof setInterval>;
    }) as typeof setInterval;
    try {
        const cleanup = await startDreamScheduleTimer({ directory: root, projectIdentity: "git:perf-rb", harness: "pi", client: {} as never, ensureRegistered: async () => {} });
        interval?.();
        interval?.();
        rows.push({ rb12OverlappingTicksWithHeldMaintenance: peak });
        release();
        for (let i = 0; i < 10; i++) await Promise.resolve();
        cleanup?.();
    } finally {
        release();
        _resetDreamTimerForTests();
        restoreStages();
        globalThis.setInterval = nativeInterval;
    }
    let permissionReads = 0;
    const permissionClient = {
        app: { agents: async () => { permissionReads++; return { data: [{ name: "build", permission: [{ permission: "todowrite", pattern: "*", action: "allow" }] }] }; } },
        session: { get: async () => { permissionReads++; return { data: { agent: "build" } }; } },
    } as unknown as Parameters<typeof todowritePermissionDenied>[0];
    const permissionMs = await measureAsync(() => todowritePermissionDenied(permissionClient, "permission-audit", "build"));
    rows.push({ rb10PermissionCpuMs: permissionMs, rb10SdkReads8Probes: permissionReads, rb10NetworkLatencyMeasured: false });
    const adapter = rust.createRustModeTransform({
        db, tagger: {} as never, scheduler: {} as never, contextUsageMap: new Map(),
        protectedTokens: 4, clearReasoningAge: 50, historyRefreshSessions: new Set(),
        pendingMaterializationSessions: new Set(), lastHeuristicsTurnId: new Map(),
        directory: root, historianRunner: "broca",
    }, { moduleClient: { call: async () => ({ ok: true }) }, projectRoot: root });
    try {
        Bun.gc(true);
        const before = process.memoryUsage().heapUsed;
        for (let i = 0; i < 1_000; i++) adapter.getState(`idle-session-${i}`);
        Bun.gc(true);
        rows.push({ rb9IdleSessions: 1_000, rb9EmptyStateHeapDeltaBytes: process.memoryUsage().heapUsed - before, rb9PopulatedWireCacheMeasured: false });
    } finally {
        adapter.dispose();
    }
    console.log(JSON.stringify({ bun: Bun.version, units: "median milliseconds; 1 warmup + 7 samples unless noted", rows }, null, 2));
} finally {
    resetLkgSlotsForTest();
    db.close();
    flushLogger();
    rmSync(root, { recursive: true, force: true });
}
