/// <reference types="bun-types" />
// Randomized multi-pass driver for the signed-prefix hold on OpenCode 1 and
// OpenCode 2 TypeScript mode (issues 665 and 664, second review). Each run
// drives one session through the real `createTransform` with a seeded sequence
// of tool steps, user turns, queued drops, execute crossings, flushes, history
// refreshes, session-directory fallbacks, idle expiry, discarded m[0]/m[1]
// pairs (first renders) and restarts.
//
// After every pass it checks:
// - a held pass (unfinished signed thinking turn on a prefix-bound model whose
//   last 15 assistant steps include one with more than 1,500 reasoning tokens,
//   below the execute threshold plus 10 points, with nothing that rewrites the
//   prefix anyway) serves the previous array unchanged for every message both
//   arrays hold;
// - strict thinking binding: a reasoning block served on two consecutive passes
//   must have identical provider-visible bytes before it on both.
//
// "OpenCode 2" here is the same transform built with the OpenCode 2 adapter's
// deps (store generation v2, a session-directory cache, no v1 compaction
// markers). It does not run the OpenCode 2 message conversion.
//
// With R2_TRACE set, every pass is appended to that file as one JSON line so
// two checkouts can be compared pass by pass.
import { afterEach, expect, it, mock, spyOn } from "bun:test";
import { createHash } from "node:crypto";
import { appendFileSync } from "node:fs";
import { appendCompartments } from "../../features/magic-context/compartment-storage";
import { createScheduler } from "../../features/magic-context/scheduler";
import {
    closeDatabase,
    getOrCreateSessionMeta,
    getPendingOps,
    getTagsBySession,
    openDatabase,
    queuePendingOp,
    updateSessionMeta,
} from "../../features/magic-context/storage";
import { clearCachedM0M1 } from "../../features/magic-context/storage-meta-shared";
import { createTagger } from "../../features/magic-context/tagger";
import type { PluginContext } from "../../plugin/types";
import * as loggerModule from "../../shared/logger";
import { cleanupTestTempDir, createTestTempDir } from "../../shared/test-temp-dir";
import { resetLkgSlotsForTest } from "./lkg-slot";
import { providerVisiblePart } from "./provider-visible-parts";
import { createTransform } from "./transform";

type Message = { info: Record<string, unknown>; parts: Array<Record<string, unknown>> };
type Host = "opencode1" | "opencode2";
type Scenario = "held" | "unheld-unbound" | "unheld-bound";

interface PassRecord {
    pass: number;
    events: string[];
    held: boolean;
    unavoidable: string[];
    refused: string | null;
    hash: string;
    length: number;
    pending: number;
    pendingBefore: number;
    pair: string;
    tags: string;
}

interface Violation {
    pass: number;
    kind: "held-prefix-changed" | "strict-binding" | "refusal" | "m0m1-rerendered" | "m0m1-folded";
    detail: string;
    events: string[];
    unavoidable: string[];
}

const PREFIX_BOUND = "claude-opus-5-5";
const UNBOUND = "claude-sonnet-5";
const BULK = "BULK const value = compute(input, options); // line\n".repeat(80);

const tempDirs: string[] = [];
const originalXdgDataHome = process.env.XDG_DATA_HOME;
afterEach(() => {
    resetLkgSlotsForTest();
    closeDatabase();
    if (originalXdgDataHome === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = originalXdgDataHome;
    for (const dir of tempDirs) cleanupTestTempDir(dir);
    tempDirs.length = 0;
});

function rng(seed: number) {
    let state = seed >>> 0;
    return () => {
        state = (state + 0x6d2b79f5) >>> 0;
        let t = state;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

function stable(value: unknown): string {
    if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
    if (value && typeof value === "object") {
        const record = value as Record<string, unknown>;
        return `{${Object.keys(record)
            .filter((key) => record[key] !== undefined)
            .sort()
            .map((key) => `${JSON.stringify(key)}:${stable(record[key])}`)
            .join(",")}}`;
    }
    return JSON.stringify(value) ?? "null";
}

/** Empty text and reasoning parts are removed by OpenCode's Anthropic adapter before the wire. */
function wireParts(parts: unknown[]): unknown[] {
    return parts
        .filter((part) => {
            const p = part as Record<string, unknown>;
            return !((p?.type === "text" || p?.type === "reasoning") && p.text === "");
        })
        .map(providerVisiblePart);
}

/** The fields of a message OpenCode builds the provider request from. */
function providerKey(message: unknown): string {
    const m = (message ?? {}) as Message;
    const info = m.info ?? {};
    return stable({
        id: info.id,
        role: info.role,
        error: info.error,
        providerID: info.providerID,
        modelID: info.modelID,
        parts: Array.isArray(m.parts) ? wireParts(m.parts) : m.parts,
    });
}

/** For each reasoning text, a hash of the provider-visible bytes in front of that part. */
function signedPrefixes(messages: readonly unknown[]): Map<string, string> {
    const out = new Map<string, string>();
    const before: string[] = [];
    for (const message of messages) {
        const m = (message ?? {}) as Message;
        const parts: unknown[] = [];
        for (const part of Array.isArray(m.parts) ? m.parts : []) {
            if (part?.type === "reasoning" && typeof part.text === "string" && part.text !== "") {
                out.set(
                    part.text,
                    createHash("sha256")
                        .update(`${before.join("\n")}\n${providerKey({ ...m, parts })}`)
                        .digest("hex"),
                );
            }
            parts.push(part);
        }
        before.push(providerKey(message));
    }
    return out;
}

function directoryClient(resolve: () => string | undefined) {
    return {
        session: {
            get: mock(async () => {
                const directory = resolve();
                return { data: directory ? { directory } : {} };
            }),
            create: mock(async () => ({ data: { id: "unused" } })),
            prompt: mock(async () => ({})),
            messages: mock(async () => ({ data: [] })),
            delete: mock(async () => ({})),
        },
    } as unknown as PluginContext["client"];
}

export async function runOpenCodeHoldDriver(options: {
    host: Host;
    scenario: Scenario;
    seed: number;
    passes: number;
    trace?: string;
}): Promise<{ records: PassRecord[]; violations: Violation[] }> {
    const random = rng(options.seed);
    // Reasoning weight and synthetic continuations draw from their own stream,
    // so a seed keeps the event sequence it had before they were added.
    const shape = rng(options.seed ^ 0x729);
    const heavyRate = Number(process.env.R2_HEAVY_RATE ?? 0.12);
    const continuationRate = Number(process.env.R2_CONTINUATION_RATE ?? 0.12);
    const recordedRate = Number(process.env.R2_RECORDED_RATE ?? 0.5);
    const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)]!;
    const modelID = options.scenario === "unheld-unbound" ? UNBOUND : PREFIX_BOUND;
    const model = { providerID: "anthropic", modelID };
    const sessionId = `r2-${options.host}-${options.scenario}-${options.seed}`;
    const dataHome = createTestTempDir("mc-r2-data-").dir;
    const sessionDirectory = createTestTempDir("mc-r2-session-dir-").dir;
    const launchDirectory = createTestTempDir("mc-r2-launch-dir-").dir;
    tempDirs.push(dataHome, sessionDirectory, launchDirectory);
    process.env.XDG_DATA_HOME = dataHome;
    const db = openDatabase();
    getOrCreateSessionMeta(db, sessionId);
    updateSessionMeta(db, sessionId, { cacheTtl: "13h", lastResponseTime: Date.now() });
    let hostDirectory: string | undefined = sessionDirectory;
    let percent = 20;
    let compartmentEnd = -1;
    let compartmentSequence = 0;
    // hasUsageTokens marks each entry as live provider usage. Without it the
    // transform ignores the entry and reads the persisted usage (none here), so
    // every pass would run at 0%.
    const usage = new Map([
        [
            sessionId,
            {
                usage: { percentage: percent, inputTokens: percent * 1000 },
                updatedAt: Date.now(),
                hasUsageTokens: true,
            },
        ],
    ]);
    const historyRefreshSessions = new Set<string>();
    const pendingMaterializationSessions = new Set<string>();
    const sessionDirectoryBySession = new Map<string, string>();
    const build = () =>
        createTransform({
            db,
            tagger: createTagger(),
            scheduler: createScheduler({ executeThresholdPercentage: 65 }),
            contextUsageMap: usage,
            historyRefreshSessions,
            pendingMaterializationSessions,
            lastHeuristicsTurnId: new Map(),
            liveModelBySession: new Map([[sessionId, model]]),
            clearReasoningAge: 50,
            protectedTokens: 2000,
            protectedTools: { read: 0 },
            historianRunnable: false,
            client: directoryClient(() => hostDirectory),
            directory: launchDirectory,
            ...(options.host === "opencode2"
                ? {
                      storeGeneration: "v2" as const,
                      sessionDirectoryBySession,
                      hostCleanupCompactionMarkers: () => ({
                          verified: true,
                          removedLineages: 0,
                          removedRows: 0,
                          retainedLineages: 0,
                      }),
                  }
                : {}),
        });
    let transform = build();
    const source: Message[] = [];
    let clock = 1;
    let call = 0;
    let thought = 0;
    // Steps mix light and heavy reasoning. A heavy step either carries the
    // host's recorded count (OpenCode's tokens.reasoning) or, with no recorded
    // count, enough stored thinking text for the estimate to exceed 1,500.
    const reasoning = (heavy = false, recorded = true) => ({
        type: "reasoning",
        text:
            heavy && !recorded
                ? `signed thought ${++thought} ${"weighing the next step carefully ".repeat(400)}`
                : `signed thought ${++thought}`,
        metadata: { anthropic: { signature: `sig-${thought}` } },
    });
    const userTurn = () => {
        if (options.scenario === "unheld-bound" && source.length > 0) {
            // Close the turn with a signed final answer, then start the next one in
            // the same step, so no pass sees the turn's thinking unfinished.
            source.push({
                info: {
                    id: `final-${clock}`,
                    role: "assistant",
                    sessionID: sessionId,
                    time: { created: clock++ },
                    finish: "stop",
                    ...model,
                },
                parts: [reasoning(), { type: "text", text: `final ${clock}` }],
            });
        }
        source.push({
            info: {
                id: `user-${clock}`,
                role: "user",
                sessionID: sessionId,
                time: { created: clock++ },
            },
            parts: [{ type: "text", text: `task ${clock}` }],
        });
    };
    // A todo continuation or background notice: a user message whose parts are
    // all synthetic. It does not end the turn.
    const syntheticContinuation = () => {
        source.push({
            info: {
                id: `continue-${clock}`,
                role: "user",
                sessionID: sessionId,
                time: { created: clock++ },
            },
            parts: [{ type: "text", text: `continue ${clock}`, synthetic: true }],
        });
    };
    const toolStep = () => {
        const callID = `call-${++call}`;
        const parts: Array<Record<string, unknown>> = [];
        const heavy = options.scenario !== "unheld-bound" && shape() < heavyRate;
        const recorded = shape() < recordedRate;
        if (options.scenario !== "unheld-bound") parts.push(reasoning(heavy, recorded));
        parts.push({
            type: "tool",
            callID,
            tool: "read",
            state: {
                status: "completed",
                input: { path: `${call}.ts` },
                output: `${callID} ${BULK}`,
            },
        });
        source.push({
            info: {
                id: `assistant-${callID}`,
                role: "assistant",
                sessionID: sessionId,
                time: { created: clock++ },
                finish: "tool-calls",
                ...model,
                tokens: {
                    input: 0,
                    output: 0,
                    reasoning: heavy && recorded ? 1_600 + Math.floor(shape() * 3_000) : 0,
                    cache: { read: 0, write: 0 },
                },
            },
            parts,
        });
    };
    // The bounded hold the transform should apply: a heavy step among the last
    // 15 assistant steps of the turn, and usage below 65% + 10.
    const recentHeavyReasoning = () => {
        let lastRealUser = -1;
        source.forEach((m, i) => {
            if (m.info.role === "user" && !m.parts.every((p) => p.synthetic === true))
                lastRealUser = i;
        });
        const steps = source
            .slice(lastRealUser + 1)
            .filter((m) => m.info.role === "assistant")
            .slice(-15);
        return steps.some((m) => {
            const recorded = (m.info.tokens as { reasoning?: number } | undefined)?.reasoning ?? 0;
            const text = m.parts.find((p) => p.type === "reasoning")?.text;
            return recorded > 1_500 || (typeof text === "string" && text.length > 6_000);
        });
    };
    const activeTurnThinking = () => {
        let lastUser = -1;
        source.forEach((m, i) => {
            if (m.info.role === "user" && !m.parts.every((p) => p.synthetic === true)) lastUser = i;
        });
        return source
            .slice(lastUser + 1)
            .some(
                (m) => m.info.role === "assistant" && m.parts.some((p) => p.type === "reasoning"),
            );
    };

    // The cached m[0]/m[1] bytes and the system hash they were folded with.
    const pairState = () => {
        const meta = getOrCreateSessionMeta(db, sessionId);
        return {
            bytes:
                meta.cachedM0Bytes && meta.cachedM1Bytes
                    ? createHash("sha256")
                          .update(String(meta.cachedM0Bytes))
                          .update("\0")
                          .update(String(meta.cachedM1Bytes))
                          .digest("hex")
                          .slice(0, 16)
                    : "",
            system: String(meta.cachedM0SystemHash ?? ""),
        };
    };
    const records: PassRecord[] = [];
    const violations: Violation[] = [];
    let previous: Message[] | null = null;
    userTurn();
    toolStep();
    for (let pass = 0; pass < options.passes; pass++) {
        const events: string[] = [];
        const unavoidable: string[] = [];
        let resetIdle = false;
        let restoreDirectory = false;
        if (pass > 1) {
            let servedUserTail = false;
            if (random() < 0.15) {
                userTurn();
                events.push("user");
                // Sometimes serve the new user message as the tail: the turn has no
                // thinking yet, so this pass is not held and may apply queued work.
                servedUserTail = random() < 0.4;
            }
            if (!servedUserTail && shape() < continuationRate) {
                syntheticContinuation();
                events.push("continuation");
            }
            if (!servedUserTail) toolStep();
            if (random() < 0.3) {
                const tools = getTagsBySession(db, sessionId).filter(
                    (tag) => tag.type === "tool" && tag.status === "active",
                );
                if (tools.length > 0) {
                    queuePendingOp(db, sessionId, pick(tools).tagNumber, "drop");
                    events.push("drop");
                }
            }
            if (random() < 0.25) {
                percent = pick([20, 40, 60, 66, 70, 80, 84]);
                if (options.scenario === "held" && random() < 0.08) percent = pick([86, 96]);
                events.push(`usage-${percent}`);
            }
            if (random() < 0.1) {
                pendingMaterializationSessions.add(sessionId);
                events.push("flush");
            }
            if (random() < 0.06) {
                historyRefreshSessions.add(sessionId);
                events.push("history-refresh");
            }
            if (random() < 0.08) {
                hostDirectory = undefined;
                sessionDirectoryBySession.delete(sessionId);
                restoreDirectory = true;
                events.push("directory-fallback");
            }
            if (random() < 0.06) {
                updateSessionMeta(db, sessionId, {
                    lastResponseTime: Date.now() - 14 * 60 * 60 * 1000,
                });
                resetIdle = true;
                events.push("idle-expiry");
            }
            // Off by default on OpenCode: resolving a compartment boundary reads the
            // OpenCode message store, which this harness does not have, so trims and
            // boundary refusals (MC-H04) under compartments are harness artifacts here.
            // The ruling tests below cover m[0]/m[1] freezing with a compartment.
            if (random() < 0.08 && process.env.R2_OC_COMPARTMENTS) {
                // A new historian compartment over an older finished turn, with the
                // history-refresh signal the historian sends: any m[0] fold from here
                // on renders different bytes. A held pass must keep replaying the old pair.
                let lastUser = -1;
                for (let index = 0; index < source.length; index++)
                    if (source[index]!.info.role === "user") lastUser = index;
                const ends: number[] = [];
                for (let index = compartmentEnd + 2; index < lastUser - 1; index++)
                    if (source[index + 1]!.info.role === "user") ends.push(index);
                if (ends.length > 0) {
                    const end = pick(ends);
                    const begin = compartmentEnd + 1;
                    const startId = (() => {
                        const index = begin;
                        return source[index]!.info.id as string;
                    })();
                    const endId = (() => {
                        const index = end;
                        return source[index]!.info.id as string;
                    })();
                    appendCompartments(db, sessionId, [
                        {
                            sequence: compartmentSequence++,
                            startMessage: begin + 1,
                            endMessage: end + 1,
                            startMessageId: startId,
                            endMessageId: endId,
                            title: `history ${pass}`,
                            content: `U: summarized work up to pass ${pass}`,
                        },
                    ]);
                    compartmentEnd = end;
                    historyRefreshSessions.add(sessionId);
                    events.push("compartment");
                }
            }
            if (random() < 0.05) {
                clearCachedM0M1(db, sessionId);
                events.push("first-render");
            }
            if (random() < 0.04) {
                resetLkgSlotsForTest();
                transform = build();
                events.push("restart");
            }
        }
        usage.set(sessionId, {
            usage: { percentage: percent, inputTokens: percent * 1000 },
            updatedAt: Date.now(),
            hasUsageTokens: true,
        });
        const meta = getOrCreateSessionMeta(db, sessionId);
        const pairMissing = !(meta.cachedM0Bytes && meta.cachedM1Bytes);
        const heldModel = modelID === PREFIX_BOUND && activeTurnThinking();
        if (pairMissing) unavoidable.push("first-render");
        if (events.includes("idle-expiry")) unavoidable.push("idle-expiry");
        if (percent >= 75) unavoidable.push("hold-cap");
        if (!recentHeavyReasoning()) unavoidable.push("no-recent-heavy-reasoning");
        const held = heldModel && unavoidable.length === 0 && previous !== null;
        const pendingBefore = getPendingOps(db, sessionId).length;
        const pairBefore = pairState();
        const messages = structuredClone(source);
        let refused: string | null = null;
        try {
            await transform({}, { messages } as never);
        } catch (error) {
            refused = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
        }
        if (resetIdle) updateSessionMeta(db, sessionId, { lastResponseTime: Date.now() });
        if (restoreDirectory) hostDirectory = sessionDirectory;
        const served = refused ? null : messages;
        if (refused)
            violations.push({ pass, kind: "refusal", detail: refused, events, unavoidable });
        if (served && previous) {
            if (held) {
                for (let index = 0; index < previous.length; index++) {
                    if (providerKey(served[index]) !== providerKey(previous[index])) {
                        violations.push({
                            pass,
                            kind: "held-prefix-changed",
                            detail: `first changed message ${index} of ${previous.length} (${String(served[index]?.info.id ?? served[index]?.info.role)})`,
                            events,
                            unavoidable,
                        });
                        break;
                    }
                }
            }
            const before = signedPrefixes(previous);
            const broken: string[] = [];
            for (const [text, prefix] of signedPrefixes(served)) {
                const old = before.get(text);
                if (old !== undefined && old !== prefix)
                    broken.push(text.replace("signed thought ", "t"));
            }
            if (broken.length > 0 && modelID === PREFIX_BOUND) {
                const firstChanged = served.findIndex(
                    (message, index) => providerKey(message) !== providerKey(previous?.[index]),
                );
                if (process.env.R2_DEBUG) {
                    const a = providerKey(previous[firstChanged]);
                    const b = providerKey(served[firstChanged]);
                    let at = 0;
                    while (at < a.length && a[at] === b[at]) at++;
                    console.log(
                        `pass ${pass} message ${firstChanged} differs at char ${at} (lengths ${a.length}/${b.length})`,
                        JSON.stringify({
                            before: a.slice(Math.max(0, at - 80), at + 160),
                            after: b.slice(Math.max(0, at - 80), at + 160),
                        }),
                    );
                }
                violations.push({
                    pass,
                    kind: "strict-binding",
                    detail: `${held ? "held" : heldModel ? "held-model" : "unheld"}: ${broken.length} kept reasoning block(s) [${broken[0]}..${broken.at(-1)}] behind changed bytes; first changed message ${firstChanged} (${String(served[firstChanged]?.info.id ?? served[firstChanged]?.info.role)})`,
                    events,
                    unavoidable,
                });
            }
        }
        const pairAfter = pairState();
        if (served && previous && heldModel && pairBefore.bytes !== "") {
            const before = signedPrefixes(previous);
            const kept = [...signedPrefixes(served).keys()].filter((key) => before.has(key));
            if (kept.length > 0 && pairAfter.bytes !== pairBefore.bytes)
                violations.push({
                    pass,
                    kind: "m0m1-rerendered",
                    detail: `cached pair ${pairBefore.bytes} -> ${pairAfter.bytes || "cleared"} with ${kept.length} kept signed block(s)`,
                    events,
                    unavoidable,
                });
            else if (kept.length > 0 && pairAfter.system !== pairBefore.system)
                violations.push({
                    pass,
                    kind: "m0m1-folded",
                    detail: `fold ran (system ${pairBefore.system} -> ${pairAfter.system}) with identical bytes and ${kept.length} kept signed block(s)`,
                    events,
                    unavoidable,
                });
        }
        const record: PassRecord = {
            pass,
            events,
            held,
            unavoidable,
            refused,
            hash: served
                ? createHash("sha256")
                      .update(served.map(providerKey).join("\n"))
                      .digest("hex")
                      .slice(0, 16)
                : "refused",
            length: served?.length ?? 0,
            pending: getPendingOps(db, sessionId).length,
            pendingBefore,
            pair: pairAfter.bytes,
            tags: createHash("sha256")
                .update(
                    getTagsBySession(db, sessionId)
                        .map((tag) => `${tag.tagNumber}:${tag.status}`)
                        .join(","),
                )
                .digest("hex")
                .slice(0, 16),
        };
        records.push(record);
        if (options.trace) appendFileSync(options.trace, `${JSON.stringify(record)}\n`);
        if (served) previous = served;
    }
    return { records, violations };
}

const SEEDS = (process.env.R2_SEEDS ?? "665,664,650,7").split(",").map((seed) => Number(seed));
const PASSES = Number(process.env.R2_PASSES ?? 150);

function summarize(violations: Violation[]) {
    return violations.map(
        (v) =>
            `pass ${v.pass} ${v.kind} [${v.events.join(" ")}] unavoidable=[${v.unavoidable.join(" ")}]: ${v.detail}`,
    );
}

// Held-driver violations by host and seed, read by the aggregate checks below.
const heldViolations = new Map<string, Violation[]>();

for (const host of ["opencode1", "opencode2"] as const) {
    for (const seed of SEEDS) {
        it(`${host} held driver seed ${seed}: held passes replay byte for byte`, async () => {
            const logs = spyOn(loggerModule, "sessionLog").mockImplementation(() => {});
            try {
                const { records, violations } = await runOpenCodeHoldDriver({
                    host,
                    scenario: "held",
                    seed,
                    passes: PASSES,
                    trace: process.env.R2_TRACE
                        ? `${process.env.R2_TRACE}.${host}-held-${seed}`
                        : undefined,
                });
                if (process.env.R2_VERBOSE)
                    console.log(
                        JSON.stringify(
                            {
                                host,
                                seed,
                                held: records.filter((r) => r.held).length,
                                violations: summarize(violations),
                            },
                            null,
                            1,
                        ),
                    );
                heldViolations.set(`${host}-${seed}`, violations);
                // The hold is bounded (recent heavy reasoning, below the cap), so
                // only part of the passes of a signed turn are held.
                expect(records.filter((r) => r.held).length).toBeGreaterThan(PASSES / 8);
                expect(summarize(violations.filter((v) => v.kind !== "strict-binding"))).toEqual(
                    [],
                );
            } finally {
                logs.mockRestore();
            }
        }, 600_000);

        for (const scenario of ["unheld-unbound", "unheld-bound"] as const) {
            it(`${host} ${scenario} driver seed ${seed}: trace for the pre-revision differential`, async () => {
                const logs = spyOn(loggerModule, "sessionLog").mockImplementation(() => {});
                try {
                    const { records, violations } = await runOpenCodeHoldDriver({
                        host,
                        scenario,
                        seed,
                        passes: Number(process.env.R2_UNHELD_PASSES ?? PASSES),
                        trace: process.env.R2_TRACE
                            ? `${process.env.R2_TRACE}.${host}-${scenario}-${seed}`
                            : undefined,
                    });
                    if (process.env.R2_VERBOSE)
                        console.log(
                            JSON.stringify(
                                { host, seed, scenario, violations: summarize(violations) },
                                null,
                                1,
                            ),
                        );
                    expect(records.some((r) => r.held)).toBe(false);
                    expect(summarize(violations.filter((v) => v.kind === "refusal"))).toEqual([]);
                } finally {
                    logs.mockRestore();
                }
            }, 600_000);
        }
    }
}

// Strict binding: a reasoning block kept on two consecutive passes must have
// identical provider-visible bytes before it. Cache expiry alone is not a
// binding rewrite, and a true rewrite must omit all affected thinking.
it("held drivers: no kept signed thinking is served behind changed bytes", () => {
    expect(heldViolations.size).toBeGreaterThan(0);
    const broken = [...heldViolations].flatMap(([run, violations]) =>
        summarize(violations.filter((v) => v.kind === "strict-binding")).map(
            (line) => `${run} ${line}`,
        ),
    );
    expect(broken).toEqual([]);
});

// Ruling for all three hosts. Every step of the signed turn below spent 1,600
// reasoning tokens, so the bounded hold applies below the cap (execute
// threshold 65% plus 10 points). There an idle-expired pass replays m[0]/m[1]
// byte for byte. At the force band (86%) and the 95% emergency the cap ends
// the hold: the pass rebuilds m[0]/m[1] mid-turn and strips every signed block
// of the turn. Earlier revisions held both cases until the next real user
// message (issue 729: a long autonomous turn sat in the force band for hours).
// Each case loads reasons to rebuild m[0]/m[1] (a new compartment with its
// history-refresh signal and a changed system prompt hash) before the pass,
// then checks the cached pair and the served head. The release pass at the end
// is the positive control: once the turn ends the same inputs rebuild the pair.
for (const host of ["opencode1", "opencode2"] as const) {
    for (const cause of ["idle expiry", "force band 86%", "emergency 96%"] as const) {
        const held = cause === "idle expiry";
        it(`${host} ruling: ${held ? `a held ${cause} pass keeps m[0]/m[1] frozen while signed thinking is kept` : `a ${cause} pass is above the hold cap: it rebuilds m[0]/m[1] mid-turn and strips every signed block`}`, async () => {
            const logs = spyOn(loggerModule, "sessionLog").mockImplementation(() => {});
            const sessionId = `r2-${host}-ruling`;
            const dataHome = createTestTempDir("mc-r2-ruling-data-").dir;
            const sessionDirectory = createTestTempDir("mc-r2-ruling-session-").dir;
            const launchDirectory = createTestTempDir("mc-r2-ruling-launch-").dir;
            tempDirs.push(dataHome, sessionDirectory, launchDirectory);
            process.env.XDG_DATA_HOME = dataHome;
            const db = openDatabase();
            try {
                getOrCreateSessionMeta(db, sessionId);
                updateSessionMeta(db, sessionId, {
                    cacheTtl: "13h",
                    lastResponseTime: Date.now(),
                    systemPromptHash: "r2-system-before",
                });
                const model = { providerID: "anthropic", modelID: PREFIX_BOUND };
                const usage = new Map([
                    [
                        sessionId,
                        {
                            usage: { percentage: 40, inputTokens: 40_000 },
                            updatedAt: Date.now(),
                            hasUsageTokens: true,
                        },
                    ],
                ]);
                const setPercent = (percentage: number) =>
                    usage.set(sessionId, {
                        usage: { percentage, inputTokens: percentage * 1000 },
                        updatedAt: Date.now(),
                        hasUsageTokens: true,
                    });
                const historyRefreshSessions = new Set<string>();
                const pendingMaterializationSessions = new Set<string>();
                const transform = createTransform({
                    db,
                    tagger: createTagger(),
                    scheduler: createScheduler({ executeThresholdPercentage: 65 }),
                    contextUsageMap: usage,
                    historyRefreshSessions,
                    pendingMaterializationSessions,
                    lastHeuristicsTurnId: new Map(),
                    liveModelBySession: new Map([[sessionId, model]]),
                    clearReasoningAge: 50,
                    protectedTokens: 2000,
                    protectedTools: { read: 0 },
                    historianRunnable: false,
                    client: directoryClient(() => sessionDirectory),
                    directory: launchDirectory,
                    ...(host === "opencode2"
                        ? {
                              storeGeneration: "v2" as const,
                              sessionDirectoryBySession: new Map<string, string>(),
                              hostCleanupCompactionMarkers: () => ({
                                  verified: true,
                                  removedLineages: 0,
                                  removedRows: 0,
                                  retainedLineages: 0,
                              }),
                          }
                        : {}),
                });
                const message = (
                    id: string,
                    role: string,
                    parts: Array<Record<string, unknown>>,
                    created: number,
                ): Message => ({
                    info: {
                        id,
                        role,
                        sessionID: sessionId,
                        time: { created },
                        ...(role === "assistant" ? { finish: "stop", ...model } : {}),
                        ...(id.startsWith("active-")
                            ? { tokens: { input: 0, output: 0, reasoning: 1_600 } }
                            : {}),
                    },
                    parts,
                });
                const source: Message[] = [
                    message("u1", "user", [{ type: "text", text: "first task" }], 1),
                    message("a1", "assistant", [{ type: "text", text: "first answer" }], 2),
                    message("u2", "user", [{ type: "text", text: "second task" }], 3),
                    message("a2", "assistant", [{ type: "text", text: "second answer" }], 4),
                    message("u3", "user", [{ type: "text", text: "current task" }], 5),
                ];
                let step = 0;
                const heldStep = () => {
                    step += 1;
                    source.push(
                        message(
                            `active-${step}`,
                            "assistant",
                            [
                                {
                                    type: "reasoning",
                                    text: `active thought ${step}`,
                                    metadata: { anthropic: { signature: `active-sig-${step}` } },
                                },
                                {
                                    type: "tool",
                                    callID: `active-call-${step}`,
                                    tool: "read",
                                    state: {
                                        status: "completed",
                                        input: { path: `${step}.ts` },
                                        output: `result ${step} ${BULK}`,
                                    },
                                },
                            ],
                            10 + step,
                        ),
                    );
                };
                const serve = async () => {
                    const messages = structuredClone(source);
                    await transform({}, { messages } as never);
                    return messages;
                };
                const pair = () => {
                    const meta = getOrCreateSessionMeta(db, sessionId);
                    return `${String(meta.cachedM0Bytes)}\u0000${String(meta.cachedM1Bytes)}\u0000${String(meta.cachedM0SystemHash)}`;
                };
                const heads = (messages: Message[]) =>
                    messages
                        .filter((m) => m.info.syntheticHead === true)
                        .map(providerKey)
                        .join("\n");
                await serve();
                heldStep();
                await serve();
                appendCompartments(db, sessionId, [
                    {
                        sequence: 0,
                        startMessage: 1,
                        endMessage: 2,
                        startMessageId: "u1",
                        endMessageId: "a1",
                        title: "first",
                        content: "U: first task\nA: first answer",
                    },
                ]);
                historyRefreshSessions.add(sessionId);
                updateSessionMeta(db, sessionId, {
                    systemPromptHash: "system-after-the-turn-started",
                });
                heldStep();
                const previous = await serve();
                const pairBefore = pair();
                expect(getOrCreateSessionMeta(db, sessionId).cachedM0SystemHash).toBe(
                    "r2-system-before",
                );
                expect(heads(previous).length).toBeGreaterThan(0);
                heldStep();
                if (cause === "idle expiry")
                    updateSessionMeta(db, sessionId, {
                        lastResponseTime: Date.now() - 14 * 60 * 60 * 1000,
                    });
                else {
                    setPercent(cause === "force band 86%" ? 86 : 96);
                    pendingMaterializationSessions.add(sessionId);
                }
                const served = await serve();
                updateSessionMeta(db, sessionId, { lastResponseTime: Date.now() });
                const before = signedPrefixes(previous);
                const kept = [...signedPrefixes(served).keys()].filter(
                    (text) => text.startsWith("active thought") && before.has(text),
                );
                if (held) {
                    expect(kept.length).toBeGreaterThan(0);
                    expect(pair()).toBe(pairBefore);
                    expect(heads(served)).toBe(heads(previous));
                    // Positive control: the turn ends and the same pending inputs rebuild the pair.
                    source.push(message("u4", "user", [{ type: "text", text: "next task" }], 99));
                    setPercent(70);
                    pendingMaterializationSessions.add(sessionId);
                    await serve();
                    expect(pair()).not.toBe(pairBefore);
                    return;
                }
                // Above the cap: the rebuild lands mid-turn, and no signed block of
                // any turn is served behind the changed head.
                expect(pair()).not.toBe(pairBefore);
                expect(heads(served)).not.toBe(heads(previous));
                expect(signedPrefixes(served).size).toBe(0);
                // The strip removes thinking only: every step of the turn is still
                // served with its tool call.
                for (const step of [1, 2, 3]) {
                    const parts = served.find((m) => m.info.id === `active-${step}`)?.parts ?? [];
                    expect(
                        parts.some((p) => p.type === "tool" && p.callID === `active-call-${step}`),
                    ).toBe(true);
                }
                return;
            } finally {
                logs.mockRestore();
            }
        }, 60_000);
    }
}
