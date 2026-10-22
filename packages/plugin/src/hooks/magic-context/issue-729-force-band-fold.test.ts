/// <reference types="bun-types" />
// Issue 729 reproduction on OpenCode 1 and OpenCode 2 (TypeScript mode).
//
// One real user message starts a long autonomous turn on Opus 5.5 (a
// prefix-bound thinking model). More than 22 tool steps follow, each with
// signed thinking, while usage climbs from 47% past the 85% force band. The
// historian publishes compartments over the turn's early steps once the force
// band is reached. Before the bounded hold, every pass of the turn was held, so
// the published history never reached the prompt until the next real user
// message. Now the first eligible bust folds mid-turn and strips the turn's
// signed thinking once, and the following steps replay that new prefix byte
// for byte (a provider cache read), with no refusal.
import { afterEach, expect, it, spyOn } from "bun:test";
import { appendCompartments } from "../../features/magic-context/compartment-storage";
import { createScheduler } from "../../features/magic-context/scheduler";
import {
    closeDatabase,
    getOrCreateSessionMeta,
    openDatabase,
    updateSessionMeta,
} from "../../features/magic-context/storage";
import { getMergedReasoningStrippedIds } from "../../features/magic-context/storage-meta-persisted";
import { createTagger } from "../../features/magic-context/tagger";
import * as loggerModule from "../../shared/logger";
import { cleanupTestTempDir, createTestTempDir } from "../../shared/test-temp-dir";
import { resetLkgSlotsForTest } from "./lkg-slot";
import { requestPendingMaterialization } from "./pending-materialization";
import { providerVisiblePart } from "./provider-visible-parts";
import { createTransform } from "./transform";

type Message = { info: Record<string, unknown>; parts: Array<Record<string, unknown>> };

const MODEL = { providerID: "anthropic", modelID: "claude-opus-5-5" };
const STEPS = 26;
const BULK = "ROW value = compute(input, options); // generated line\n".repeat(60);

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

function providerKey(message: Message | undefined): string {
    if (!message) return "missing";
    return JSON.stringify({
        id: message.info.id,
        role: message.info.role,
        parts: message.parts
            .filter((p) => !((p.type === "text" || p.type === "reasoning") && p.text === ""))
            .map(providerVisiblePart),
    });
}

function signedBlocks(messages: Message[]): string[] {
    return messages.flatMap((m) =>
        m.parts
            .filter(
                (p) =>
                    p.type === "reasoning" &&
                    typeof p.text === "string" &&
                    p.text !== "" &&
                    (p.metadata as { anthropic?: unknown } | undefined)?.anthropic !== undefined,
            )
            .map((p) => String(p.text)),
    );
}

/** Usage for step `n` before the fold: 47% at the first step, 2 points more per step. */
const usageAt = (step: number) => Math.min(97, 47 + step * 2);

for (const host of ["opencode1", "opencode2"] as const) {
    it(`${host}: a long signed turn in the force band folds mid-turn, strips its thinking once and then replays`, async () => {
        const logs: string[] = [];
        const log = spyOn(loggerModule, "sessionLog").mockImplementation((...args: unknown[]) => {
            logs.push(args.slice(1).map(String).join(" "));
        });
        const sessionId = `issue-729-${host}`;
        const dataHome = createTestTempDir("mc-729-data-").dir;
        const sessionDirectory = createTestTempDir("mc-729-session-").dir;
        tempDirs.push(dataHome, sessionDirectory);
        process.env.XDG_DATA_HOME = dataHome;
        const db = openDatabase();
        try {
            getOrCreateSessionMeta(db, sessionId);
            updateSessionMeta(db, sessionId, { cacheTtl: "59m", lastResponseTime: Date.now() });
            const usage = new Map([
                [
                    sessionId,
                    {
                        usage: { percentage: usageAt(0), inputTokens: usageAt(0) * 1680 },
                        updatedAt: Date.now(),
                        hasUsageTokens: true,
                    },
                ],
            ]);
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
            });
            const message = (
                id: string,
                role: "user" | "assistant",
                parts: Array<Record<string, unknown>>,
                created: number,
                extra: Record<string, unknown> = {},
            ): Message => ({
                info: { id, role, sessionID: sessionId, time: { created }, ...extra },
                parts,
            });
            const source: Message[] = [
                message("u-old", "user", [{ type: "text", text: "earlier task" }], 1),
                message("a-old", "assistant", [{ type: "text", text: "earlier answer" }], 2, {
                    finish: "stop",
                    ...MODEL,
                }),
                message("u-task", "user", [{ type: "text", text: "run 26 bash commands" }], 3),
            ];
            const step = (n: number) => {
                // A todo continuation every few steps: synthetic, so it does not
                // end the turn.
                if (n % 5 === 4)
                    source.push(
                        message(
                            `continue-${n}`,
                            "user",
                            [
                                {
                                    type: "text",
                                    text: "Continue with the todo list.",
                                    synthetic: true,
                                },
                            ],
                            10 + n * 3,
                        ),
                    );
                source.push(
                    message(
                        `step-${n}`,
                        "assistant",
                        [
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
                        11 + n * 3,
                        {
                            finish: "tool-calls",
                            ...MODEL,
                            tokens: { input: 0, output: 400, reasoning: 300 },
                        },
                    ),
                );
            };
            const pair = () => {
                const meta = getOrCreateSessionMeta(db, sessionId);
                return `${String(meta.cachedM0Bytes)}\u0000${String(meta.cachedM1Bytes)}`;
            };
            const bindingStrips = () =>
                [...getMergedReasoningStrippedIds(db, sessionId)].filter((id) =>
                    id.startsWith("binding_mismatch:step-"),
                );

            await transform({}, { messages: structuredClone(source) } as never);
            const served: Message[][] = [];
            const pairs: string[] = [];
            const strips: number[] = [];
            let published = -1;
            for (let n = 0; n < STEPS; n++) {
                step(n);
                // After the fold the provider reports the smaller prompt: the
                // reporter's run went from 87.9% to 59.4% on the folding step.
                const percentage = published >= 0 ? 60 + (n - published - 1) * 2 : usageAt(n);
                usage.set(sessionId, {
                    usage: { percentage, inputTokens: percentage * 1680 },
                    updatedAt: Date.now(),
                    hasUsageTokens: true,
                });
                // The historian publishes a compartment over the turn's first ten
                // steps once the session reaches the force band.
                if (published < 0 && percentage >= 85) {
                    appendCompartments(db, sessionId, [
                        {
                            sequence: 0,
                            startMessage: 1,
                            endMessage: 5,
                            startMessageId: "u-old",
                            endMessageId: "step-1",
                            title: "earlier work and the first commands",
                            content: "U: earlier task\nA: ran the first two commands",
                        },
                    ]);
                    historyRefreshSessions.add(sessionId);
                    published = n;
                }
                const messages = structuredClone(source);
                // A refusal throws here and fails the test.
                await transform({}, { messages } as never);
                served.push(messages);
                pairs.push(pair());
                strips.push(bindingStrips().length);
            }
            expect(published).toBeGreaterThan(0);
            expect(STEPS).toBeGreaterThan(22);

            // The first eligible bust after publication folds mid-turn: the cached
            // m[0]/m[1] pair changes on that pass and the summarized rows leave
            // the prompt.
            const fold = pairs.findIndex((value, index) => index > 0 && value !== pairs[index - 1]);
            expect(fold).toBe(published);
            const foldServed = served[fold]!;
            expect(foldServed.some((m) => m.info.id === "step-0")).toBe(false);
            expect(foldServed.length).toBeLessThan(served[fold - 1]!.length);
            expect(foldServed.some((m) => m.info.id === `step-${fold}`)).toBe(true);
            expect(
                logs.some((line) => /m\[0\] HARD fold decision: .*executed=true/.test(line)),
            ).toBe(true);

            // It strips the turn's signed thinking once: every step served so far
            // is frozen on that one pass, and no signed block is served behind
            // the new head.
            expect(strips[fold - 1]).toBe(0);
            expect(strips[fold]).toBe(fold + 1);
            expect(signedBlocks(foldServed)).toEqual([]);

            // The next step reads the new prefix from cache: every message the
            // fold pass served is served again byte for byte, and only the new
            // step follows, keeping its own signed thinking.
            for (let next = fold + 1; next < STEPS; next++) {
                const previous = served[next - 1]!;
                const current = served[next]!;
                for (let index = 0; index < previous.length; index++)
                    expect({ next, index, key: providerKey(current[index]) }).toEqual({
                        next,
                        index,
                        key: providerKey(previous[index]),
                    });
                expect(pairs[next]).toBe(pairs[fold]);
                expect(strips[next]).toBe(strips[fold]);
            }
            expect(signedBlocks(served.at(-1)!)).toContain(
                `step ${STEPS - 1}: run the next command`,
            );
            expect(logs.some((line) => line.includes("over the model window"))).toBe(false);

            // The turn's real user message is now summarized away, yet a later
            // bust (a user flush) still strips every signed block kept since the
            // fold.
            requestPendingMaterialization(pendingMaterializationSessions, sessionId, "user_flush");
            const flushed = structuredClone(source);
            await transform({}, { messages: flushed } as never);
            expect(signedBlocks(flushed)).toEqual([]);
            expect(bindingStrips().length).toBeGreaterThan(strips.at(-1)!);
        } finally {
            log.mockRestore();
        }
    }, 120_000);
}
