/// <reference types="bun-types" />
// Witnesses from an independent cache-safety review of the bounded
// signed-thinking hold (issue 729).
//
// Every scenario drives the real OpenCode transform on a prefix-bound model
// (Opus 5.5) with a strict-binding oracle: a signed thinking block is valid
// only while every provider-visible byte in front of it equals the request
// that produced it, except that a gap-free run of the oldest thinking blocks
// may be removed (Anthropic's documented valid edit). The oracle compares each
// served block's prefix with the served array of the pass whose response
// created the block, so a head change on the very next pass is caught too.
//
// Each test asserts the oracle finds nothing, so a red test is a finding:
// - a compaction-off session whose cache expires mid-turn: checks the signed
//   thinking kept behind the re-rendered m[0];
// - a last-good replay followed by a held idle-expiry pass: checks the signed
//   thinking kept behind the replayed step once it is re-tagged.
// To compare with another revision, copy this file into that checkout and run
// it there.
import { afterEach, expect, it, spyOn } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { createScheduler } from "../../features/magic-context/scheduler";
import {
    closeDatabase,
    getOrCreateSessionMeta,
    openDatabase,
    updateSessionMeta,
} from "../../features/magic-context/storage";
import { createTagger } from "../../features/magic-context/tagger";
import { createMessagesTransformHandler } from "../../plugin/messages-transform";
import * as loggerModule from "../../shared/logger";
import { cleanupTestTempDir, createTestTempDir } from "../../shared/test-temp-dir";
import { resetLkgSlotsForTest } from "./lkg-slot";
import { providerVisiblePart } from "./provider-visible-parts";
import { createTransform } from "./transform";

const MODEL = { providerID: "anthropic", modelID: "claude-opus-5-5" };
const BULK = "ROW value = compute(input, options); // generated line\n".repeat(40);

type Message = { info: Record<string, unknown>; parts: Array<Record<string, unknown>> };

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

const isThinking = (part: Record<string, unknown>) =>
    part.type === "reasoning" &&
    typeof part.text === "string" &&
    part.text !== "" &&
    (part.metadata as { anthropic?: unknown } | undefined)?.anthropic !== undefined;
const signatureOf = (part: Record<string, unknown>) =>
    String(
        (part.metadata as { anthropic?: { signature?: unknown } } | undefined)?.anthropic
            ?.signature,
    );

/** Provider view of one served message: role and visible parts, no ids. */
function view(message: Message): { role: unknown; parts: string[] } {
    return {
        role: message.info.role,
        parts: message.parts
            .filter((p) => !((p.type === "text" || p.type === "reasoning") && p.text === ""))
            .filter((p) => p.ignored !== true)
            .map((p) =>
                isThinking(p)
                    ? `THINK:${signatureOf(p)}:${String(p.text)}`
                    : JSON.stringify(providerVisiblePart(p as never)),
            ),
    };
}

/**
 * Strict-binding oracle. `born(signature, servedArray)` records the request a
 * block was produced in; `check(servedArray)` returns every block served
 * behind bytes that differ from that request.
 */
export class StrictBinding {
    private births = new Map<string, Array<{ role: unknown; parts: string[] }>>();
    born(signature: string, served: Message[]): void {
        this.births.set(signature, served.map(view));
    }
    check(served: Message[]): string[] {
        const problems: string[] = [];
        const views = served.map(view);
        for (let index = 0; index < served.length; index++) {
            const message = served[index]!;
            for (const part of message.parts) {
                if (!isThinking(part)) continue;
                const signature = signatureOf(part);
                const birth = this.births.get(signature);
                if (!birth) continue;
                const reason = compare(birth, views.slice(0, index));
                if (reason) problems.push(`${signature}: ${reason}`);
            }
        }
        return problems;
    }
}

function compare(
    birth: Array<{ role: unknown; parts: string[] }>,
    now: Array<{ role: unknown; parts: string[] }>,
): string | null {
    if (birth.length !== now.length)
        return `prefix has ${now.length} messages, birth had ${birth.length}`;
    const birthThinking: string[] = [];
    const nowThinking: string[] = [];
    for (let i = 0; i < birth.length; i++) {
        const a = birth[i]!;
        const b = now[i]!;
        if (a.role !== b.role) return `message ${i} role changed`;
        const aOther = a.parts.filter((p) => !p.startsWith("THINK:"));
        const bOther = b.parts.filter((p) => !p.startsWith("THINK:"));
        if (JSON.stringify(aOther) !== JSON.stringify(bOther))
            return `message ${i} bytes changed (${firstDiff(aOther, bOther)})`;
        birthThinking.push(...a.parts.filter((p) => p.startsWith("THINK:")));
        nowThinking.push(...b.parts.filter((p) => p.startsWith("THINK:")));
    }
    // Only a gap-free run of the oldest blocks may be gone.
    const offset = birthThinking.length - nowThinking.length;
    if (offset < 0) return "prefix gained thinking blocks";
    for (let i = 0; i < nowThinking.length; i++)
        if (birthThinking[offset + i] !== nowThinking[i])
            return "thinking in front was removed from the middle or edited";
    return null;
}

function firstDiff(a: string[], b: string[]): string {
    for (let i = 0; i < Math.max(a.length, b.length); i++)
        if (a[i] !== b[i])
            return `part ${i}: ${String(a[i]).slice(0, 80)} -> ${String(b[i]).slice(0, 80)}`;
    return "same";
}

function signedSignatures(messages: Message[]): string[] {
    return messages.flatMap((m) => m.parts.filter(isThinking).map(signatureOf));
}

for (const host of ["opencode1", "opencode2"] as const) {
    it(`${host}: compaction-off, unheld signed turn, idle-expiry fold re-renders m[0] in front of kept signed thinking`, async () => {
        const logs: string[] = [];
        const log = spyOn(loggerModule, "sessionLog").mockImplementation((...args: unknown[]) => {
            logs.push(args.slice(1).map(String).join(" "));
        });
        const sessionId = `review-729-off-${host}`;
        const dataHome = createTestTempDir("mc-r729-data-").dir;
        const sessionDirectory = createTestTempDir("mc-r729-session-").dir;
        tempDirs.push(dataHome, sessionDirectory);
        process.env.XDG_DATA_HOME = dataHome;
        writeFileSync(join(sessionDirectory, "ARCHITECTURE.md"), "# Architecture\n\nv1\n");
        const db = openDatabase();
        try {
            getOrCreateSessionMeta(db, sessionId);
            updateSessionMeta(db, sessionId, { cacheTtl: "5m", lastResponseTime: Date.now() });
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
            const transform = createTransform({
                db,
                tagger: createTagger(),
                scheduler: createScheduler({ executeThresholdPercentage: 65 }),
                contextUsageMap: usage,
                historyRefreshSessions: new Set<string>(),
                pendingMaterializationSessions: new Set<string>(),
                lastHeuristicsTurnId: new Map(),
                liveModelBySession: new Map([[sessionId, MODEL]]),
                protectedTokens: 2000,
                protectedTools: { bash: 0 },
                historianRunnable: false,
                compactionOff: true,
                injectDocs: true,
                directory: sessionDirectory,
                sessionDirectoryBySession: new Map([[sessionId, sessionDirectory]]),
                ...(host === "opencode2"
                    ? {
                          storeGeneration: "v2" as const,
                          hostCleanupCompactionMarkers: () => ({
                              verified: true,
                              removedLineages: 0,
                              removedRows: 0,
                              retainedLineages: 0,
                          }),
                      }
                    : {}),
            } as never);
            const source: Message[] = [
                {
                    info: {
                        id: "u-task",
                        role: "user",
                        sessionID: sessionId,
                        time: { created: 1 },
                    },
                    parts: [{ type: "text", text: "run some bash commands" }],
                },
            ];
            const oracle = new StrictBinding();
            const problems: string[] = [];
            let served: Message[] = [];
            const serve = async () => {
                const messages = structuredClone(source);
                await transform({}, { messages } as never);
                problems.push(...oracle.check(messages).map((p) => `pass ${pass}: ${p}`));
                served = messages;
            };
            let pass = 0;
            const step = (n: number) => {
                source.push({
                    info: {
                        id: `step-${n}`,
                        role: "assistant",
                        sessionID: sessionId,
                        time: { created: 10 + n },
                        finish: "tool-calls",
                        ...MODEL,
                        // A light step: no recent heavy reasoning, so never held.
                        tokens: { input: 0, output: 300, reasoning: 200 },
                    },
                    parts: [
                        {
                            type: "reasoning",
                            text: `step ${n}: run the next command`,
                            metadata: { anthropic: { signature: `sig-${n}` } },
                        },
                        {
                            type: "tool",
                            callID: `call-${n}`,
                            tool: "bash",
                            state: {
                                status: "completed",
                                input: { command: `seq ${n}` },
                                output: `${n}\n${BULK}`,
                            },
                        },
                    ],
                });
                oracle.born(`sig-${n}`, served);
            };
            await serve();
            for (pass = 1; pass <= 3; pass++) {
                step(pass);
                await serve();
            }
            const before = getOrCreateSessionMeta(db, sessionId).cachedM0Bytes?.toString();
            // Simulate a cache expiry (as after a tool call longer than the
            // TTL) and change the project docs before the next pass.
            writeFileSync(join(sessionDirectory, "ARCHITECTURE.md"), "# Architecture\n\nv2\n");
            // The head was materialized before the last response, which
            // finished more than one TTL ago (the idle-expiry fold's own
            // condition that makes an idle-expiry fold eligible).
            db.prepare(
                "UPDATE session_meta SET cached_m0_materialized_at = ? WHERE session_id = ?",
            ).run(Date.now() - 20 * 60 * 1000, sessionId);
            updateSessionMeta(db, sessionId, {
                lastResponseTime: Date.now() - 10 * 60 * 1000,
            });
            step(4);
            pass = 4;
            await serve();
            const after = getOrCreateSessionMeta(db, sessionId).cachedM0Bytes?.toString();
            const kept = signedSignatures(served);
            console.log(
                `[review-729] ${host} compaction-off idle fold: m0Changed=${before !== after} keptSigned=${JSON.stringify(kept)} problems=${JSON.stringify(problems)} fold=${JSON.stringify(logs.filter((l) => l.includes("HARD fold decision")))}`,
            );
            expect(problems).toEqual([]);
        } finally {
            log.mockRestore();
        }
    }, 60_000);
}

/** A small OpenCode session on a prefix-bound model with the strict-binding oracle. */
async function harness(
    host: "opencode1" | "opencode2",
    sessionId: string,
    extraDeps: Record<string, unknown> = {},
) {
    const dataHome = createTestTempDir("mc-r729-data-").dir;
    const sessionDirectory = createTestTempDir("mc-r729-session-").dir;
    tempDirs.push(dataHome, sessionDirectory);
    process.env.XDG_DATA_HOME = dataHome;
    const db = openDatabase();
    getOrCreateSessionMeta(db, sessionId);
    updateSessionMeta(db, sessionId, { cacheTtl: "5m", lastResponseTime: Date.now() });
    const usage = new Map([
        [
            sessionId,
            {
                usage: { percentage: 30, inputTokens: 30_000 },
                updatedAt: Date.now(),
                hasUsageTokens: true,
            },
        ],
    ]);
    const pending = new Set<string>();
    const logs: string[] = [];
    const transform = createTransform({
        db,
        tagger: createTagger(),
        scheduler: createScheduler({ executeThresholdPercentage: 65 }),
        contextUsageMap: usage,
        historyRefreshSessions: new Set<string>(),
        pendingMaterializationSessions: pending,
        lastHeuristicsTurnId: new Map(),
        liveModelBySession: new Map([[sessionId, MODEL]]),
        protectedTokens: 2000,
        protectedTools: { bash: 0 },
        historianRunnable: false,
        directory: sessionDirectory,
        sessionDirectoryBySession: new Map([[sessionId, sessionDirectory]]),
        ...(host === "opencode2"
            ? {
                  storeGeneration: "v2" as const,
                  hostCleanupCompactionMarkers: () => ({
                      verified: true,
                      removedLineages: 0,
                      removedRows: 0,
                      retainedLineages: 0,
                  }),
              }
            : {}),
        ...extraDeps,
    } as never);
    // Through the production wrapper, so a failed pass replays the last good
    // request exactly as the plugin does.
    let failNext = false;
    const handler = createMessagesTransformHandler({
        magicContext: {
            "experimental.chat.messages.transform": async (input: unknown, output: unknown) => {
                if (failNext) {
                    failNext = false;
                    throw Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" });
                }
                await transform(input as never, output as never);
            },
        },
    } as never);
    const source: Message[] = [];
    const oracle = new StrictBinding();
    const problems: string[] = [];
    let served: Message[] = [];
    let clock = 1;
    let pass = 0;
    const setUsage = (percentage: number) =>
        usage.set(sessionId, {
            usage: { percentage, inputTokens: percentage * 1000 },
            updatedAt: Date.now(),
            hasUsageTokens: true,
        });
    return {
        db,
        logs,
        pending,
        source,
        problems,
        setUsage,
        served: () => served,
        failNextPass() {
            failNext = true;
        },
        user(text: string) {
            source.push({
                info: {
                    id: `u${clock}`,
                    role: "user",
                    sessionID: sessionId,
                    time: { created: clock++ },
                },
                parts: [{ type: "text", text }],
            });
        },
        step(n: number, reasoning: number, text = `step ${n}: run the next command`) {
            source.push({
                info: {
                    id: `step-${n}`,
                    role: "assistant",
                    sessionID: sessionId,
                    time: { created: clock++ },
                    finish: "tool-calls",
                    ...MODEL,
                    tokens: { input: 0, output: 300, reasoning },
                },
                parts: [
                    {
                        type: "reasoning",
                        text,
                        metadata: { anthropic: { signature: `sig-${n}` } },
                    },
                    {
                        type: "tool",
                        callID: `call-${n}`,
                        tool: "bash",
                        state: {
                            status: "completed",
                            input: { command: `seq ${n}` },
                            output: `${n}\n${BULK}`,
                        },
                    },
                ],
            });
            oracle.born(`sig-${n}`, served);
        },
        idle() {
            db.prepare(
                "UPDATE session_meta SET cached_m0_materialized_at = ? WHERE session_id = ?",
            ).run(Date.now() - 3 * 60 * 60 * 1000, sessionId);
            updateSessionMeta(db, sessionId, {
                lastResponseTime: Date.now() - 2 * 60 * 60 * 1000,
            });
        },
        async serve() {
            pass++;
            logs.length = 0;
            const log = spyOn(loggerModule, "sessionLog").mockImplementation(
                (...args: unknown[]) => {
                    logs.push(args.slice(1).map(String).join(" "));
                },
            );
            try {
                const messages = structuredClone(source);
                await handler({}, { messages } as never);
                problems.push(...oracle.check(messages).map((p) => `pass ${pass}: ${p}`));
                served = messages;
                updateSessionMeta(db, sessionId, { lastResponseTime: Date.now() });
                return messages;
            } finally {
                log.mockRestore();
            }
        },
    };
}

for (const host of ["opencode1", "opencode2"] as const) {
    it(`${host}: after a last-good replay, a held idle-expiry pass tags the replayed step's tool result in front of kept signed thinking`, async () => {
        const h = await harness(host, `review-729-lkgidle-${host}`);
        h.user("long task");
        await h.serve();
        // A heavy-reasoning step (2,400 tokens), so the pass is held.
        h.step(1, 2_400);
        await h.serve();
        // The pass fails and the wrapper replays the last good request with
        // the new step appended as the host sent it (no tag on its result).
        h.failNextPass();
        h.step(2, 200);
        await h.serve();
        h.step(3, 200);
        await h.serve();
        // The cache expires while the turn is still held.
        h.idle();
        h.step(4, 200);
        const out = await h.serve();
        const tools = out
            .flatMap((m) => m.parts)
            .filter((p) => p.type === "tool")
            .map((p) => String((p.state as { output?: string }).output).slice(0, 6));
        console.log(
            `[review-729] ${host} lkg then held idle: kept=${JSON.stringify(signedSignatures(out))} tools=${JSON.stringify(tools)} problems=${JSON.stringify(h.problems)} logs=${JSON.stringify(h.logs.filter((l) => /hold|frozen|WILL|strip|fold decision|lkg/.test(l)))}`,
        );
        expect(h.problems).toEqual([]);
    }, 60_000);
}
