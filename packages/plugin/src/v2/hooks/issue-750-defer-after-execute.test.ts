import { expect, spyOn, test } from "bun:test";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as configLoader from "../../config";
import { MagicContextConfigSchema } from "../../config/schema/magic-context";
import { appendCompartments } from "../../features/magic-context/compartment-storage";
import { closeDatabase, openDatabase } from "../../features/magic-context/storage";
import * as retention from "../../features/magic-context/storage-host-instruction-retention";
import { setHostInstructionRetentionEnabledForTests } from "../../features/magic-context/storage-host-instruction-retention";
import * as incremental from "../../hooks/magic-context/compartment-runner-incremental";
import { resetCtxReduceRegisteredGloballyForTest } from "../../hooks/magic-context/ctx-reduce-availability";
import { resetLkgSlotsForTest } from "../../hooks/magic-context/lkg-slot";
import * as transformModule from "../../hooks/magic-context/transform";
import { _resetDreamTimerForTests } from "../../plugin/dream-timer";
import { setHarness } from "../../shared/harness";
import * as logger from "../../shared/logger";
import * as models from "../../shared/models-dev-cache";
import { resetOpenCodeDbPathStateForTesting } from "../../shared/opencode-db-path";
import * as sqlite from "../../shared/sqlite";
import { Database } from "../../shared/sqlite";
import { cleanupTestTempDir, createTestTempDirFromPath } from "../../shared/test-temp-dir";
import { resetHostMediaForTests } from "../fold/host-media";
import { registerContext } from "./context";
import * as storageGate from "./storage-gate";
import type { SessionContext, V2Context, V2Message } from "./types";

const prose =
    "Please review the implementation and verify the results carefully before we continue with the next deployment cache invalidation step. ";

type Row = {
    id: string;
    type: "user" | "assistant" | "system";
    text: string;
    created: number;
    seq: number;
    /** Provider input tokens recorded on an assistant row (drives context usage). */
    inputTokens?: number;
};

/**
 * A real OpenCode 2 context hook over an isolated store. Rows carry 10-minute
 * gaps (so temporal markers render) and OpenCode 2 instruction-update `system`
 * rows, which the host renders as id-less system messages.
 */
async function fixture(
    seed: number,
    {
        provider = "openai",
        model = "gpt-4.1",
        cacheTtl = "5m",
        historian = false,
        instructions = true,
        temporal = true,
    } = {},
) {
    setHarness("opencode2");
    const base = join(tmpdir(), "magic-context/issue-750");
    mkdirSync(base, { recursive: true });
    const root = createTestTempDirFromPath(join(base, `seed-${seed}-`));
    const keys = [
        "HOME",
        "XDG_DATA_HOME",
        "XDG_CONFIG_HOME",
        "XDG_CACHE_HOME",
        "XDG_STATE_HOME",
        "MAGIC_CONTEXT_STORAGE_DIR",
        "MAGIC_CONTEXT_LOG_PATH",
        "OPENCODE_DB",
        "MC_OC2_INVISIBLE_FOLD",
    ];
    const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
    for (const key of keys.filter((key) => key !== "MC_OC2_INVISIBLE_FOLD"))
        process.env[key] = join(root, key);
    delete process.env.MC_OC2_INVISIBLE_FOLD;
    const start = 1770000000000 + seed * 100000000;
    let nowClock = start;
    const clock = spyOn(Date, "now").mockImplementation(() => nowClock);
    for (const key of keys.filter(
        (key) => !["MAGIC_CONTEXT_LOG_PATH", "OPENCODE_DB", "MC_OC2_INVISIBLE_FOLD"].includes(key),
    ))
        mkdirSync(process.env[key]!, { recursive: true });
    resetOpenCodeDbPathStateForTesting();
    const raw = new Database(process.env.OPENCODE_DB!);
    raw.exec(
        "CREATE TABLE IF NOT EXISTS session_message (id TEXT PRIMARY KEY, session_id TEXT, type TEXT, seq INTEGER, time_created INTEGER, time_updated INTEGER, data TEXT); CREATE TABLE IF NOT EXISTS session_v2 (id TEXT PRIMARY KEY, directory TEXT NOT NULL, parent_id TEXT, fork_session_id TEXT, fork_boundary TEXT);",
    );
    const db = openDatabase();
    if (!db) throw new Error("isolated database unavailable");
    const realRoot = realpathSync(root);
    for (const row of db.prepare("PRAGMA database_list").all() as Array<{ file: string }>)
        if (row.file && !row.file.startsWith(`${root}/`) && !row.file.startsWith(`${realRoot}/`))
            throw new Error("database escaped isolated root");
    const config = MagicContextConfigSchema.parse({
        auto_update: false,
        embedding: { provider: "off" },
        historian: { disable: !historian },
        dreamer: { disable: true },
        memory: { enabled: false, git_commit_indexing: { enabled: false } },
        temporal_awareness: temporal,
        mural: { enabled: false },
        protected_tokens: 4000,
        commit_cluster_trigger: { enabled: false },
        cache_ttl: cacheTtl,
    });
    const configPath = join(process.env.XDG_CONFIG_HOME!, "cortexkit");
    mkdirSync(configPath, { recursive: true });
    writeFileSync(join(configPath, "magic-context.jsonc"), JSON.stringify(config));
    const load = spyOn(configLoader, "loadPluginConfigDetailed").mockReturnValue({
        config,
    } as ReturnType<typeof configLoader.loadPluginConfigDetailed>);
    const probe = spyOn(storageGate, "probeV2StorageAtBoot").mockResolvedValue(db);
    const logs = spyOn(logger, "sessionLog");
    const storage = new Map<string, unknown>();
    let hooks = new Map<string, (draft: SessionContext) => Promise<void>>();
    let duties: Awaited<ReturnType<typeof registerContext>> | undefined;
    const host = {
        location: { directory: root },
        agent: { transform: async () => {}, reload: async () => {} },
        model: {
            list: () => [{ id: model, providerID: provider, limit: { context: 1000000 } }],
        },
        storage: {
            get: async (key: string) => storage.get(key),
            set: async (key: string, value: unknown) => {
                storage.set(key, structuredClone(value));
            },
        },
        event: { subscribe: async function* () {} },
        tool: { hook: async () => {} },
        session: {
            remove: async () => {},
            compact: async () => {},
            interrupt: async () => ({ interrupted: true }),
            hook: async (name: string, callback: (draft: SessionContext) => Promise<void>) => {
                hooks.set(name, callback);
            },
            get: async () => ({ location: { directory: root } }),
        },
    } as unknown as V2Context;
    const session = `ses750-${seed}`;
    raw.prepare("INSERT OR IGNORE INTO session_v2(id,directory) VALUES (?,?)").run(session, root);
    const rows: Row[] = [];
    // Store order: every row and host compaction takes the next seq, so rows
    // written after a checkpoint sort after it, as on the real host.
    let nextSeq = 0;
    let turn = 0;
    const addRow = (type: Row["type"], text: string, advanceMs = 600000) => {
        rows.push({ id: `r${seed}-${rows.length}`, type, text, created: nowClock, seq: nextSeq++ });
        nowClock += advanceMs;
    };
    const addTurn = () => {
        addRow("assistant", `${seed}/${turn}: ${prose.repeat(2 + ((seed + turn) % 5))}`);
        addRow("user", `${seed}/${turn}: ${prose.repeat(1 + ((seed + turn) % 3))}`);
        turn++;
    };
    const persist = () => {
        raw.prepare(
            "DELETE FROM session_message WHERE session_id = ? AND type != 'compaction'",
        ).run(session);
        for (const row of rows) {
            const data =
                row.type === "assistant"
                    ? {
                          content: [{ type: "text", text: row.text }],
                          model: { providerID: provider, id: model },
                          time: { created: row.created, completed: row.created + 1000 },
                          tokens: {
                              input: row.inputTokens ?? 10000,
                              output: 50,
                              reasoning: 0,
                              cache: { read: 0, write: 0 },
                          },
                      }
                    : { text: row.text, time: { created: row.created } };
            raw.prepare(
                "INSERT INTO session_message(id,session_id,type,seq,time_created,data) VALUES (?,?,?,?,?,?)",
            ).run(row.id, session, row.type, row.seq, row.created, JSON.stringify(data));
        }
    };
    const render = (row: Row): V2Message =>
        row.type === "system"
            ? { role: "system", content: [{ type: "text", text: row.text }] }
            : { id: row.id, role: row.type, content: [{ type: "text", text: row.text }] };
    let checkpoint: V2Message | undefined;
    let hostWindowStart = 0;
    let lastDraft: SessionContext | undefined;
    const inputDraft = (): SessionContext => ({
        sessionID: session,
        model: { providerID: provider, id: model, limit: { context: 1000000 } },
        agent: "build",
        system: [{ type: "text", text: "Review the isolated project." }],
        tools: { read: { description: "Read a file", input: { type: "object" } } },
        options: {},
        messages: structuredClone([
            ...(checkpoint ? [checkpoint] : []),
            ...rows.slice(hostWindowStart).map(render),
        ]),
    });
    addRow("user", `${seed}: start ${prose.repeat(2)}`);
    for (let n = 0; n < 12; n++) {
        addTurn();
        if (instructions && (n === 2 || n === 6 || n === 8))
            addRow("system", `Today's date is now: day ${n}.`);
    }
    persist();
    const startHook = async () => {
        await duties?.dispose();
        resetCtxReduceRegisteredGloballyForTest();
        resetLkgSlotsForTest();
        hooks = new Map();
        duties = await registerContext(host);
        if (!hooks.has("context")) throw new Error("real context hook missing");
    };
    await startHook();
    const ordinalOf = (id: string) => rows.findIndex((row) => row.id === id) + 1;
    let compartments = 0;
    let coveredThrough = -1;
    return {
        db,
        raw,
        rows,
        session,
        /** A new plugin process over the same stores (an upgrade restart). */
        restart: startHook,
        get coveredThrough() {
            return coveredThrough;
        },
        async pass() {
            const draft = inputDraft();
            const before = logs.mock.calls.length;
            await hooks.get("context")!(draft);
            lastDraft = structuredClone(draft);
            return {
                draft,
                bytes: JSON.stringify({ system: draft.system, messages: draft.messages }),
                logs: logs.mock.calls.slice(before).map((args) => args.map(String).join(" ")),
            };
        },
        /** A pass whose refusal is returned rather than thrown. */
        async attempt() {
            const draft = inputDraft();
            const before = logs.mock.calls.length;
            let error: unknown;
            try {
                await hooks.get("context")!(draft);
            } catch (caught) {
                error = caught;
            }
            return {
                draft,
                error,
                logs: logs.mock.calls.slice(before).map((args) => args.map(String).join(" ")),
            };
        },
        /** Publish the next compartment, covering rows through `endIndex` (a served row). */
        compartment(endIndex: number) {
            if (rows[endIndex]!.type === "system") throw new Error("boundary must be served");
            const sequence = compartments++;
            const startIndex = coveredThrough + 1;
            coveredThrough = endIndex;
            appendCompartments(db, session, [
                {
                    sequence,
                    startMessage: startIndex + 1,
                    endMessage: endIndex + 1,
                    startMessageId: rows[startIndex]!.id,
                    endMessageId: rows[endIndex]!.id,
                    title: `Review history ${sequence}`,
                    content: prose.repeat(3),
                    p1: prose.repeat(3),
                    p2: prose.repeat(2),
                    p3: "Reviewed the cache policy.",
                    p4: "Cache policy reviewed.",
                    legacy: 0,
                },
            ]);
            return ordinalOf(rows[endIndex]!.id);
        },
        /** The host folds: a compaction row after every row, then a short host window. */
        async fold(windowRows = 3) {
            const draft = structuredClone(lastDraft!);
            await hooks.get("compaction")!(draft);
            if (!draft.result) throw new Error("compaction hook supplied no summary");
            const id = `fold-${seed}-${rows.length}`;
            raw.prepare(
                "INSERT INTO session_message(id,session_id,type,seq,time_created,data) VALUES (?,?,?,?,?,?)",
            ).run(
                id,
                session,
                "compaction",
                nextSeq++,
                Date.now(),
                JSON.stringify({
                    status: "completed",
                    summary: draft.result.summary,
                    time: { completed: Date.now() },
                }),
            );
            checkpoint = {
                id,
                role: "user",
                content: [{ type: "text", text: `<summary>\n${draft.result.summary}\n</summary>` }],
            };
            hostWindowStart = rows.length - windowRows;
        },
        /** Let the provider cache expire, so the next pass may rebuild the prefix. */
        idle(hours = 3) {
            nowClock += hours * 3600000;
        },
        /** The provider answers the last request: a new assistant row completes now. */
        respond(repeat = 1, inputTokens?: number) {
            addRow("assistant", `${seed}/reply ${rows.length}: ${prose.repeat(repeat)}`, 5000);
            if (inputTokens !== undefined) rows[rows.length - 1]!.inputTokens = inputTokens;
            persist();
        },
        /** A user turn after `gapMs` of quiet, optionally carrying an injected reminder. */
        user(text: string, gapMs: number) {
            nowClock += gapMs;
            addRow("user", text, 1000);
            persist();
        },
        /** An OpenCode 2 instruction update (for example the daily date line). */
        instruction(text: string) {
            addRow("system", text, 1000);
            persist();
        },
        async cleanup() {
            await duties?.dispose();
            logs.mockRestore();
            probe.mockRestore();
            load.mockRestore();
            clock.mockRestore();
            _resetDreamTimerForTests();
            closeDatabase();
            raw.close();
            resetLkgSlotsForTest();
            resetCtxReduceRegisteredGloballyForTest();
            for (const key of keys) {
                if (saved[key] === undefined) delete process.env[key];
                else process.env[key] = saved[key];
            }
            resetOpenCodeDbPathStateForTesting();
            resetHostMediaForTests();
            cleanupTestTempDir(root);
        },
    };
}

function firstDivergence(a: V2Message[], b: V2Message[]): string | null {
    for (let index = 0; index < Math.max(a.length, b.length); index++) {
        const left = JSON.stringify(a[index] ?? null);
        const right = JSON.stringify(b[index] ?? null);
        if (left !== right)
            return `message ${index}: ${left.slice(0, 160)} !== ${right.slice(0, 160)}`;
    }
    return null;
}

const instructionTexts = (messages: V2Message[]) =>
    messages
        .filter((message) => !message.id && message.role === "system")
        .map((message) => String(message.content[0]?.text ?? ""));

// OpenCode 2 sends instruction-update rows as id-less system messages. The
// executing pass moves the history boundary past one of them, and the defer
// pass right after must replay the executing pass's bytes. On the base commit
// the executing pass served the covered instruction row (the delivery trim
// keeps every id-less instruction) while the defer pass dropped it: its
// history trim cut it (no checkpoint), or the restore after a host checkpoint
// started at the new boundary. The request diverged right after the two
// leading session-history messages (m[0] and m[1]). Covered instruction rows
// are now served by every pass.
for (const checkpoint of [true, false])
    test(`issue 750 repro: defer pass after an executed fold replays the execute pass bytes (${checkpoint ? "after a host checkpoint" : "no checkpoint"})`, async () => {
        const f = await fixture(checkpoint ? 750 : 751);
        try {
            f.compartment(4);
            const first = await f.pass();
            const firstReplay = await f.pass();
            expect(firstDivergence(first.draft.messages, firstReplay.draft.messages)).toBeNull();
            if (checkpoint) await f.fold();
            const afterFold = await f.pass();
            const afterFoldReplay = await f.pass();
            expect(
                firstDivergence(afterFold.draft.messages, afterFoldReplay.draft.messages),
            ).toBeNull();
            // Rows 5 onward are served, with "day 2" (row 7).
            expect(instructionTexts(afterFold.draft.messages)).toContain(
                "Today's date is now: day 2.",
            );
            // The next compartment covers rows 5..15, across that instruction row.
            f.compartment(15);
            f.idle();
            const execute = await f.pass();
            expect(execute.logs.join("\n")).toMatch(/transform scheduler: .*decision=execute/);
            f.respond();
            const defer = await f.pass();
            expect(defer.logs.join("\n")).toMatch(/transform scheduler: .*decision=defer/);
            expect(defer.draft.system).toEqual(execute.draft.system);
            expect(
                firstDivergence(
                    execute.draft.messages,
                    defer.draft.messages.slice(0, execute.draft.messages.length),
                ),
            ).toBeNull();
            // Every instruction row stays, including the one the new boundary covers.
            const instructions = [
                "Today's date is now: day 2.",
                "Today's date is now: day 6.",
                "Today's date is now: day 8.",
            ];
            expect(instructionTexts(execute.draft.messages)).toEqual(instructions);
            expect(instructionTexts(defer.draft.messages)).toEqual(instructions);
        } finally {
            await f.cleanup();
        }
    }, 60000);

const reminder = (n: number) =>
    `<system-reminder>\nTodo continuation ${n}: keep working on the open items.\n</system-reminder>`;

/**
 * Randomized served-byte differential over the real OpenCode 2 hook. Executing
 * passes (TTL expiry) and defer passes interleave with new turns, temporal gaps,
 * instruction rows, injected reminders (heuristic cleanup), published
 * compartments and host checkpoints. A defer pass must start with the exact
 * messages its predecessor served: checked for every tool-loop follow-up, and
 * for each new turn unless a host checkpoint or cache expiry came before it.
 * Every pass must also serve every instruction row of the session.
 */
async function runDifferential(provider: string, model: string, seeds: number[], steps: number) {
    let passes = 0;
    let deferChecks = 0;
    let executes = 0;
    let boundaryMoves = 0;
    let instructionsCovered = 0;
    let hardFolds = 0;
    let checkpointPasses = 0;
    const failures: string[] = [];
    for (const seed of seeds) {
        const f = await fixture(seed, { provider, model, cacheTtl: "1h" });
        let random = seed;
        const next = (bound: number) => {
            random = (Math.imul(random, 1664525) + 1013904223) >>> 0;
            return random % bound;
        };
        try {
            f.compartment(4);
            let previous = await f.pass();
            passes++;
            let folds = 0;
            for (let step = 0; step < steps; step++) {
                const action = next(10);
                let mayRebuild = false;
                let comparable = true;
                if (action === 0 && folds < 2 && f.rows.length > 20) {
                    await f.fold(3 + next(3));
                    folds++;
                    // A host checkpoint replaces the head; that request is a new prefix.
                    comparable = false;
                } else if (action <= 2) {
                    // Publish a compartment ending a few rows behind the tail.
                    const limit = f.rows.length - 6;
                    let end = Math.min(limit, f.coveredThrough + 3 + next(6));
                    while (end > f.coveredThrough && f.rows[end]?.type === "system") end--;
                    if (end > f.coveredThrough + 1) {
                        const coveredInstructions = f.rows
                            .slice(f.coveredThrough + 1, end + 1)
                            .filter((row) => row.type === "system").length;
                        f.compartment(end);
                        boundaryMoves++;
                        instructionsCovered += coveredInstructions;
                    }
                } else if (action === 3) {
                    f.instruction(`Today's date is now: ${seed} day ${step}.`);
                }
                if (next(4) === 0) {
                    f.idle(2);
                    mayRebuild = true;
                }
                const gap = next(3) === 0 ? 120000 : 600000 + next(4) * 900000;
                if (gap > 3600000) mayRebuild = true;
                f.user(
                    `${next(3) === 0 ? `${reminder(step)}\n` : ""}${seed}/${step}: ${prose.repeat(1 + next(3))}`,
                    gap,
                );
                const current = await f.pass();
                passes++;
                const log = current.logs.join("\n");
                if (/HARD fold decision: .*executed=true/.test(log)) hardFolds++;
                if (folds > 0) checkpointPasses += 2;
                // The first render already allowed a prefix rewrite, so this
                // session serves every instruction row it has, covered or not.
                const allInstructions = f.rows
                    .filter((row) => row.type === "system")
                    .map((row) => row.text);
                if (
                    JSON.stringify(instructionTexts(current.draft.messages)) !==
                    JSON.stringify(allInstructions)
                )
                    failures.push(
                        `${provider} seed ${seed} step ${step}: instruction rows ${JSON.stringify(instructionTexts(current.draft.messages))}`,
                    );
                const deferred = /transform scheduler: .*decision=defer/.test(log);
                if (/transform scheduler: .*decision=execute/.test(log)) executes++;
                if (comparable && deferred && !mayRebuild) {
                    deferChecks++;
                    const divergence = firstDivergence(
                        previous.draft.messages,
                        current.draft.messages.slice(0, previous.draft.messages.length),
                    );
                    if (
                        divergence ||
                        JSON.stringify(current.draft.system) !==
                            JSON.stringify(previous.draft.system)
                    )
                        failures.push(
                            `${provider} seed ${seed} step ${step}: ${divergence ?? "system changed"}`,
                        );
                }
                f.respond(1 + next(2));
                // The tool-loop follow-up: same turn, five seconds later, always a defer.
                const followUp = await f.pass();
                passes++;
                const followLog = followUp.logs.join("\n");
                if (/transform scheduler: .*decision=execute/.test(followLog)) executes++;
                if (/transform scheduler: .*decision=defer/.test(followLog)) {
                    deferChecks++;
                    const divergence = firstDivergence(
                        current.draft.messages,
                        followUp.draft.messages.slice(0, current.draft.messages.length),
                    );
                    if (
                        divergence ||
                        JSON.stringify(followUp.draft.system) !==
                            JSON.stringify(current.draft.system)
                    )
                        failures.push(
                            `${provider} seed ${seed} step ${step} follow-up: ${divergence ?? "system changed"}`,
                        );
                }
                previous = followUp;
                f.respond();
            }
        } finally {
            await f.cleanup();
        }
    }
    return {
        passes,
        deferChecks,
        executes,
        hardFolds,
        checkpointPasses,
        boundaryMoves,
        instructionsCovered,
        failures,
    };
}

for (const [provider, model] of [
    ["openai", "gpt-4.1"],
    ["anthropic", "claude-opus-4-1"],
] as const) {
    test(`issue 750 differential: ${provider} defer passes replay their predecessor over 200+ passes`, async () => {
        const result = await runDifferential(provider, model, [7501, 7502, 7503, 7504], 30);
        console.log(`ISSUE750 ${provider} ${JSON.stringify(result)}`);
        expect(result.passes).toBeGreaterThanOrEqual(200);
        expect(result.executes).toBeGreaterThan(0);
        expect(result.instructionsCovered).toBeGreaterThan(0);
        expect(result.checkpointPasses).toBeGreaterThan(0);
        expect(result.failures).toEqual([]);
    }, 600000);
}

for (const checkpoint of [true, false]) {
    test(`issue 750 upgrade: covered instructions first return on a rewriting pass (${checkpoint ? "after a host checkpoint" : "no checkpoint"})`, async () => {
        // Serve the session as releases before the switch did: covered
        // instruction rows were cut by the history trim and not restored.
        setHostInstructionRetentionEnabledForTests(false);
        const f = await fixture(checkpoint ? 7510 : 7511);
        try {
            f.compartment(4);
            await f.pass();
            if (checkpoint) await f.fold();
            await f.pass();
            f.compartment(15);
            f.idle();
            await f.pass();
            f.respond();
            const legacy = await f.pass();
            expect(legacy.logs.join("\n")).toMatch(/transform scheduler: .*decision=defer/);
            expect(instructionTexts(legacy.draft.messages)).not.toContain(
                "Today's date is now: day 2.",
            );
            // Upgrade: a new process with the switch available, then a defer pass.
            setHostInstructionRetentionEnabledForTests(true);
            await f.restart();
            f.respond();
            const upgraded = await f.pass();
            expect(upgraded.logs.join("\n")).toMatch(/transform scheduler: .*decision=defer/);
            expect(upgraded.draft.system).toEqual(legacy.draft.system);
            expect(
                firstDivergence(
                    legacy.draft.messages,
                    upgraded.draft.messages.slice(0, legacy.draft.messages.length),
                ),
            ).toBeNull();
            // The next pass allowed to rewrite the prefix serves the covered row.
            f.idle();
            const rewrite = await f.pass();
            expect(rewrite.logs.join("\n")).toMatch(/transform scheduler: .*decision=execute/);
            expect(instructionTexts(rewrite.draft.messages)).toEqual([
                "Today's date is now: day 2.",
                "Today's date is now: day 6.",
                "Today's date is now: day 8.",
            ]);
            f.respond();
            const replay = await f.pass();
            expect(replay.logs.join("\n")).toMatch(/transform scheduler: .*decision=defer/);
            expect(
                firstDivergence(
                    rewrite.draft.messages,
                    replay.draft.messages.slice(0, rewrite.draft.messages.length),
                ),
            ).toBeNull();
        } finally {
            setHostInstructionRetentionEnabledForTests(true);
            await f.cleanup();
        }
    }, 60000);
}

// At 95% context and above a pass waits for the historian and, once the run
// publishes, prepares the history a second time at the new boundary. That
// second cut must set covered instruction rows aside exactly like the first
// cut of the next pass, so the pass that joined the historian and the defer
// pass after it serve the same instruction rows. The historian's model call is
// replaced by a stub that publishes one compartment; the join, the publication
// signal and the re-preparation are the real ones. While a session has a cached
// m[0], both preparations trim at its stored boundary, so the re-preparation
// cuts new rows only on a pass without one (here, after a compaction-mode switch).
test("issue 750: a historian join at 97% and the defer pass after it serve the same bytes", async () => {
    const f = await fixture(752, { historian: true });
    let published = 0;
    const agent = spyOn(incremental, "runCompartmentAgent").mockImplementation(async (deps) => {
        if (published++ > 0) return;
        // Covers rows 5..15, across the "day 2" instruction row (row 7).
        f.compartment(15);
        deps.onCompartmentStatePublished?.(deps.sessionId);
    });
    try {
        f.compartment(4);
        await f.pass();
        f.respond();
        await f.pass();
        // A compaction-mode switch clears the cached m[0]/m[1] bytes (the same
        // statement as clearCachedM0Baseline in compaction-off-transition.ts),
        // so the next trim follows the newest compartment. That pass arrives at
        // 97% of the window: it blocks on the historian, which publishes a
        // compartment across "day 2".
        f.db
            .prepare(
                "UPDATE session_meta SET cached_m0_bytes = NULL, cached_m1_bytes = NULL, cached_m0_mural_data_url = NULL WHERE session_id = ?",
            )
            .run(f.session);
        f.respond(1, 970_000);
        const joined = await f.pass();
        const joinedLog = joined.logs.join("\n");
        expect(joinedLog).toMatch(/blocking at 97\.\d% until compartment agent completes/);
        expect(joinedLog).toContain("compartment agent completed, refreshing compartment coverage");
        expect(published).toBe(1);
        // The usage after the joined request is ordinary again: a defer pass.
        f.respond();
        const defer = await f.pass();
        expect(defer.logs.join("\n")).toMatch(/transform scheduler: .*decision=defer/);
        expect(defer.draft.system).toEqual(joined.draft.system);
        expect(
            firstDivergence(
                joined.draft.messages,
                defer.draft.messages.slice(0, joined.draft.messages.length),
            ),
        ).toBeNull();
        expect(instructionTexts(joined.draft.messages)).toEqual([
            "Today's date is now: day 2.",
            "Today's date is now: day 6.",
            "Today's date is now: day 8.",
        ]);
    } finally {
        agent.mockRestore();
        await f.cleanup();
    }
}, 60000);

/**
 * Make the next request's first writer admission report a busy database once,
 * as another process holding the writer does, before the admission succeeds.
 */
function installBusyAdmission() {
    const realAdmit = sqlite.withAsyncPrivilegedWriter;
    const state = { busyNext: false };
    const spy = spyOn(sqlite, "withAsyncPrivilegedWriter").mockImplementation((async (
        ...args: Parameters<typeof realAdmit>
    ) => {
        if (state.busyNext) {
            state.busyNext = false;
            args[2]?.beforeRetry?.(new sqlite.SqliteAcquisitionBusyError("database is locked"));
        }
        return realAdmit(...args);
    }) as typeof realAdmit);
    return { state, restore: () => spy.mockRestore() };
}

const lkgEvents = (logs: string[]) =>
    logs
        .filter((line) => /\blkg_[a-z_]+$/.test(line))
        .map((line) => line.replace(/^.*\b(lkg_[a-z_]+)$/, "$1"))
        .join(",");

/** Make the next transform pass fail with a transient SQLite error, as a busy writer does. */
function installTransientFailure() {
    const realCreate = transformModule.createTransform;
    const state = { failNext: false };
    const spy = spyOn(transformModule, "createTransform").mockImplementation(((
        deps: Parameters<typeof realCreate>[0],
    ) => {
        const real = realCreate(deps);
        const wrapped = async (...args: Parameters<typeof real>) => {
            if (state.failNext) {
                state.failNext = false;
                throw Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" });
            }
            return real(...args);
        };
        return Object.assign(wrapped, real) as typeof real;
    }) as typeof realCreate);
    return { state, restore: () => spy.mockRestore() };
}

// Without a host checkpoint and without any instruction row there are no
// covered rows, so a busy database must end as it did before covered rows were
// served. On OpenCode 2 in TypeScript mode that earlier code does not replay
// here either:
// - at admission the draft is adapted without the stored message times the
//   transform input carries, so the saved copy's content digests differ:
//   lkg_content_mismatch, then the pass runs;
// - inside the transform the host's fit check compares the saved system prompt
//   with one that already carries Magic Context's guidance and declines:
//   lkg_replay_does_not_fit, then a refusal.
for (const where of ["admission", "transform"] as const)
    test(`issue 750: a busy database before any checkpoint ends as before covered rows were served (${where})`, async () => {
        const failure = installTransientFailure();
        const busy = installBusyAdmission();
        const limit = spyOn(models, "getSdkContextLimit").mockReturnValue(1_000_000);
        const f = await fixture(754, { instructions: false });
        try {
            f.compartment(4);
            await f.pass();
            f.respond();
            const before = await f.pass();
            f.respond();
            if (where === "admission") busy.state.busyNext = true;
            else failure.state.failNext = true;
            const failed = await f.attempt();
            console.log(
                `ISSUE750_LKG pre-checkpoint ${where} error=${failed.error ? String(failed.error).slice(0, 80) : "none"} lkg=${lkgEvents(failed.logs)}`,
            );
            if (where === "admission") {
                expect(lkgEvents(failed.logs)).toBe("lkg_content_mismatch");
                expect(failed.error).toBeUndefined();
                expect(
                    firstDivergence(
                        before.draft.messages,
                        failed.draft.messages.slice(0, before.draft.messages.length),
                    ),
                ).toBeNull();
            } else {
                expect(lkgEvents(failed.logs)).toBe("lkg_replay_does_not_fit,lkg_replay_declined");
                expect(String(failed.error)).toContain("database is busy");
            }
        } finally {
            busy.restore();
            failure.restore();
            limit.mockRestore();
            await f.cleanup();
        }
    }, 60000);

// After a host checkpoint the restored covered instruction rows reach the
// transform handler without ids, and the request serves them. The saved copy
// must still be captured and the entry check must skip those rows, so a busy
// database ends as it did before covered rows were served, when the history
// trim cut every covered row and the request had no id-less row:
// - at admission the entry is the host draft without the restored rows, which
//   never matches the saved input: lkg_invalidated_reshape, then the pass runs;
// - inside the transform the candidate is built and reaches the host's fit
//   check, which declines it: lkg_replay_does_not_fit, then a refusal.
// Neither may end as lkg_miss (no saved copy at all).
for (const where of ["admission", "transform"] as const)
    test(`issue 750: a busy database after a checkpoint ends as before covered rows were served (${where})`, async () => {
        const failure = installTransientFailure();
        const busy = installBusyAdmission();
        const limit = spyOn(models, "getSdkContextLimit").mockReturnValue(1_000_000);
        const f = await fixture(753);
        try {
            f.compartment(4);
            await f.pass();
            // Every instruction row (rows 7, 16, 21) is covered. Before covered
            // rows were served, the trim cut them all and the request had no
            // id-less row.
            f.compartment(22);
            f.idle();
            await f.pass();
            f.respond();
            await f.pass();
            await f.fold();
            f.user(`753 after the checkpoint: ${prose}`, 120000);
            await f.pass();
            f.respond();
            const before = await f.pass();
            f.respond();
            if (where === "admission") busy.state.busyNext = true;
            else failure.state.failNext = true;
            const failed = await f.attempt();
            console.log(
                `ISSUE750_LKG after-checkpoint ${where} error=${failed.error ? String(failed.error).slice(0, 80) : "none"} lkg=${lkgEvents(failed.logs)} instructions=${instructionTexts(before.draft.messages).length}`,
            );
            if (where === "admission") {
                expect(lkgEvents(failed.logs)).toBe("lkg_invalidated_reshape");
                expect(failed.error).toBeUndefined();
                expect(
                    firstDivergence(
                        before.draft.messages,
                        failed.draft.messages.slice(0, before.draft.messages.length),
                    ),
                ).toBeNull();
            } else {
                expect(lkgEvents(failed.logs)).toBe("lkg_replay_does_not_fit,lkg_replay_declined");
                expect(String(failed.error)).toContain("database is busy");
            }
        } finally {
            busy.restore();
            failure.restore();
            limit.mockRestore();
            await f.cleanup();
        }
    }, 60000);

// The switch that serves covered instruction rows decides bytes a later pass
// replays, so a pass that cannot read it, or cannot save it on the pass that
// turns it on, must refuse rather than guess.
for (const failure of ["read", "write"] as const)
    test(`issue 750: a pass refuses when the instruction-row switch cannot be ${failure === "read" ? "read" : "saved"}`, async () => {
        const spy =
            failure === "read"
                ? spyOn(retention, "isHostInstructionRetentionOn").mockImplementation(() => {
                      throw new Error("replay document unreadable");
                  })
                : spyOn(retention, "markHostInstructionRetention").mockReturnValue(false);
        const f = await fixture(failure === "read" ? 755 : 756);
        try {
            f.compartment(4);
            // The first pass may rewrite the whole prefix, so it reads (and on
            // first use saves) the switch.
            const first = await f.attempt();
            const site =
                failure === "read"
                    ? "host-instruction-retention-read-failure"
                    : "host-instruction-retention-persistence-failure";
            expect(first.logs.join("\n")).toContain(`transform refused degraded pass site=${site}`);
            expect(first.error).toBeDefined();
        } finally {
            spy.mockRestore();
            await f.cleanup();
        }
    }, 60000);

// A compartment can end after the host checkpoint. Instruction rows between
// the checkpoint and that boundary are still sent by the host in its own
// window, so the restore must stop at the checkpoint, or those rows would be
// served twice.
test("issue 750: an instruction row after the checkpoint is served once when the boundary passes it", async () => {
    const f = await fixture(757);
    try {
        f.compartment(4);
        await f.pass();
        f.respond();
        await f.pass();
        await f.fold();
        f.user(`757 after the checkpoint: ${prose}`, 120000);
        f.respond(3);
        f.instruction("Today's date is now: after the checkpoint.");
        f.user(`757 next turn: ${prose}`, 120000);
        const boundary = f.rows.length;
        f.respond(3);
        f.user(`757 later turn: ${prose}`, 120000);
        f.respond(3);
        f.user(`757 latest turn: ${prose.repeat(2)}`, 120000);
        await f.pass();
        f.respond();
        // The new compartment ends after the checkpoint, past the instruction row.
        f.compartment(boundary);
        f.idle();
        const execute = await f.pass();
        f.respond();
        const defer = await f.pass();
        expect(defer.logs.join("\n")).toMatch(/transform scheduler: .*decision=defer/);
        for (const served of [execute, defer])
            expect(
                instructionTexts(served.draft.messages).filter(
                    (text) => text === "Today's date is now: after the checkpoint.",
                ),
            ).toHaveLength(1);
        expect(
            firstDivergence(
                execute.draft.messages,
                defer.draft.messages.slice(0, execute.draft.messages.length),
            ),
        ).toBeNull();
    } finally {
        await f.cleanup();
    }
}, 60000);
