import { expect, test } from "bun:test";
import { appendCompartments } from "../../features/magic-context/compartment-storage";
import {
    getActiveTagsBySession,
    getOrCreateSessionMeta,
    getPendingOps,
    getTagsBySession,
    queuePendingOp,
} from "../../features/magic-context/storage";
import { createTagger } from "../../features/magic-context/tagger";
import { adaptPayload } from "../../v2/hooks/payload";
import type { SessionContext } from "../../v2/hooks/types";
import { createAutoSearchReplayFixture } from "./auto-search-replay.fixture";
import { opencode1ToModelMessages } from "./opencode1-to-model-messages.fixture";
import { requestPendingMaterialization } from "./pending-materialization";
import { type MessageLike, tagMessages } from "./tag-messages";
import { applyFlushedStatuses } from "./transform-operations";
import { runPostTransformPhase } from "./transform-postprocess-phase";

export function openCodeRideHarness(host: "opencode" | "opencode2", legacy = false) {
    const fixture = createAutoSearchReplayFixture(host, "deferred-ride");
    const { db, sessionId: id } = fixture;
    const pending = new Set<string>();
    const history = new Set<string>();
    const deferred = new Set<string>();
    let previous: MessageLike[] | null = null;
    let legacyBlock = "Baseline legacy history";
    const source: MessageLike[] = Array.from({ length: 18 }, (_, i) => ({
        info: {
            id: `msg_${String(i).padStart(4, "0")}`,
            role: i % 2 ? "assistant" : "user",
            sessionID: id,
        },
        parts: [
            {
                id: `part_${i}`,
                type: "text",
                text: `Message ${i}: independent historical content.`,
            },
        ],
    }));
    appendCompartments(db, id, [
        {
            sequence: 0,
            startMessage: 1,
            endMessage: 2,
            startMessageId: "msg_0000",
            endMessageId: "msg_0001",
            title: "Baseline",
            content: "Existing history facts.\n".repeat(500),
            p1: "Existing history facts.\n".repeat(500),
        },
    ]);
    return {
        db,
        id,
        signal() {
            history.add(id);
            deferred.add(id);
        },
        flush() {
            requestPendingMaterialization(pending, id, "user_flush");
        },
        publish() {
            legacyBlock = "Fresh legacy history";
            appendCompartments(db, id, [
                {
                    sequence: 1,
                    startMessage: 3,
                    endMessage: 4,
                    startMessageId: "msg_0002",
                    endMessageId: "msg_0003",
                    title: "Fresh publication",
                    content: "New history facts.\n".repeat(20),
                    p1: "New history facts.\n".repeat(20),
                },
            ]);
            history.add(id);
            deferred.add(id);
        },
        queue() {
            const tag = getTagsBySession(db, id).find((tag) =>
                tag.messageId.startsWith("msg_0007"),
            );
            if (!tag) throw new Error("missing queued target");
            queuePendingOp(db, id, tag.tagNumber, "drop");
        },
        async pass(percentage = 66) {
            const draft: SessionContext = {
                sessionID: id,
                model: { providerID: "openai", id: "gpt-test" },
                agent: "build",
                system: ["Fixed system prompt."],
                tools: {},
                options: {},
                messages: source.map((message) => ({
                    id: message.info.id,
                    role: message.info.role,
                    content: [{ type: "text", text: message.parts[0]!.text as string }],
                })) as SessionContext["messages"],
            };
            const mapped = host === "opencode2" ? adaptPayload(draft) : null;
            const messages = mapped ? (mapped.messages as MessageLike[]) : structuredClone(source);
            const tagger = createTagger();
            tagger.initFromDb(id, db);
            const tagged = tagMessages(id, messages, tagger, db);
            const tags = getActiveTagsBySession(db, id);
            applyFlushedStatuses(id, db, tagged.targets, getTagsBySession(db, id));
            await runPostTransformPhase({
                sessionId: id,
                db,
                messages,
                tags,
                ...tagged,
                tagger,
                ctxReduceAvailability: { callable: true, frozen: true },
                todowriteAvailability: { callable: false, frozen: true },
                batch: null,
                contextUsage: { percentage, inputTokens: percentage * 1000 },
                usableWindow: 96_000,
                schedulerDecision: percentage >= 65 ? "execute" : "defer",
                fullFeatureMode: true,
                canRunCompartments: false,
                awaitedCompartmentRun: false,
                phaseJustAwaitedPublication: false,
                compartmentInProgress: false,
                historyRefreshExplicitBeforePrepare: false,
                deferredHistoryWasPendingAtPassStart: history.has(id),
                compartmentInjectionRebuiltFromDb: false,
                rebuiltHistoryFromInitialPrepare: false,
                historyRebuiltThisPass: history.has(id),
                canConsumeDeferredLate: percentage >= 65,
                sessionMeta: getOrCreateSessionMeta(db, id),
                currentTurnId: null,
                pendingMaterializationSessions: pending,
                deferredHistoryRefreshSessions: history,
                deferredMaterializationSessions: deferred,
                lastHeuristicsTurnId: new Map(),
                protectedTagIds: new Set(),
                protectedTagNumbers: new Set(),
                protectedCutoff: null,
                protectedCount: 0,
                pendingCompartmentInjection: legacy
                    ? {
                          block: legacyBlock,
                          compartmentEndMessage: 0,
                          compartmentEndMessageId: null,
                          compartmentCount: 1,
                          skippedVisibleMessages: 0,
                          factCount: 0,
                          memoryCount: 0,
                          rebuiltFromDb: history.has(id),
                      }
                    : null,
                didMutateFromFlushedStatuses: false,
                watermark: 0,
                forceMaterializationPercentage: 85,
                hasRecentReduceCall: false,
                readLastServedMessages: () => previous,
                m0M1: legacy
                    ? undefined
                    : {
                          ...fixture.renderOptions("openai/gpt-test"),
                          memoryEnabled: false,
                          temporalAwareness: false,
                      },
            });
            previous = structuredClone(messages);
            if (mapped) {
                mapped.commit();
                return structuredClone(draft.messages);
            }
            return opencode1ToModelMessages(messages, {
                providerID: "openai",
                id: "gpt-test",
                api: { npm: "@ai-sdk/openai", id: "gpt-test" },
            });
        },
        close() {
            fixture.close();
        },
    };
}

function firstDifference(previous: unknown[], next: unknown[]) {
    const index = previous.findIndex(
        (message, i) => JSON.stringify(message) !== JSON.stringify(next[i]),
    );
    return index < 0 && previous.length === next.length
        ? null
        : index < 0
          ? previous.length
          : index;
}

for (const host of ["opencode", "opencode2"] as const) {
    test(`${host} legacy history admits drops only when the served history block changes`, async () => {
        const h = openCodeRideHarness(host, true);
        try {
            const previous = await h.pass(40);
            h.queue();
            h.signal();
            expect(await h.pass()).toEqual(previous);
            expect(getPendingOps(h.db, h.id)).toHaveLength(1);
            h.publish();
            const next = await h.pass();
            expect(next).not.toEqual(previous);
            expect(getPendingOps(h.db, h.id)).toHaveLength(0);
            expect(await h.pass()).toEqual(next);
        } finally {
            h.close();
        }
    });
    for (const kind of ["publication", "noop", "flush"] as const) {
        test(`${host} ${kind} uses served bytes or a real user flush for drop admission`, async () => {
            const run = async (queue: boolean) => {
                const h = openCodeRideHarness(host);
                try {
                    const previous = await h.pass(40);
                    if (kind === "publication") h.publish();
                    else if (kind === "flush") h.flush();
                    else h.signal();
                    if (queue) h.queue();
                    const next = await h.pass();
                    const pending = getPendingOps(h.db, h.id).length;
                    const warm = await h.pass();
                    if (kind === "noop") {
                        h.publish();
                        await h.pass();
                        expect(getPendingOps(h.db, h.id)).toHaveLength(0);
                    }
                    return { previous, next, warm, pending };
                } finally {
                    h.close();
                }
            };
            const withheld = await run(false);
            const applied = await run(true);
            expect(applied.previous).toEqual(withheld.previous);
            expect(applied.warm).toEqual(applied.next);
            expect(withheld.warm).toEqual(withheld.next);
            if (kind === "noop") {
                expect(applied.next).toEqual(applied.previous);
                expect(applied.pending).toBe(1);
            } else {
                expect(applied.pending).toBe(0);
                expect(applied.next).not.toEqual(withheld.next);
                if (kind === "publication") {
                    // Both host projections merge the adjacent synthetic user slots.
                    expect(firstDifference(withheld.previous, withheld.next)).toBe(0);
                    expect(firstDifference(applied.previous, applied.next)).toBe(0);
                } else {
                    expect(withheld.next).toEqual(withheld.previous);
                    expect(applied.next.slice(0, 2)).toEqual(applied.previous.slice(0, 2));
                }
            }
        });
    }
}
