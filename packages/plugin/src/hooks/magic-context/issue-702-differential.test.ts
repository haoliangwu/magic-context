import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { replaceAllCompartments } from "../../features/magic-context/compartment-storage";
import { getOrCreateSessionMeta } from "../../features/magic-context/storage";
import { initializeDatabase } from "../../features/magic-context/storage-db";
import { Database } from "../../shared/sqlite";
import { createTestTempDir } from "../../shared/test-temp-dir";
import { createV2RawMessageProvider, createV2RawMessageReader } from "../../v2/hooks/store";
import { V2StoreReader } from "../../v2/store-reader";
import {
    capturePrefixTrimSourceOrder,
    type InjectM0M1Result,
    injectM0M1,
    resetPrefixTrimFallbackState,
} from "./inject-compartments";
import { withRawMessageProvider } from "./read-session-chunk";
import { closeReadOnlySessionDb } from "./read-session-db";
import type { MessageLike } from "./tag-messages";

// A fixed PRNG makes comparisons across code revisions reproducible without sharing
// expected results with the trimming implementation.
function randomSource() {
    let seed = 702;
    return () => {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        return seed / 0x100000000;
    };
}

for (const host of ["oc1", "oc2"] as const) {
    test(`issue 702 differential: ${host} randomized in-order serialized arrays`, () => {
        const random = randomSource();
        const root = createTestTempDir("issue-702-differential-");
        const priorDataHome = process.env.XDG_DATA_HOME;
        process.env.XDG_DATA_HOME = root.dir;
        closeReadOnlySessionDb();
        const sessionId = `issue-702-differential-${host}`;
        const db = new Database(":memory:");
        initializeDatabase(db);
        const state = getOrCreateSessionMeta(db, sessionId);
        const source: MessageLike[] = Array.from({ length: 32 }, (_, index) => ({
            info: {
                id: `msg_${String(index).padStart(4, "0")}`,
                role: "user",
                sessionID: sessionId,
            },
            parts: [{ type: "text", text: `row ${index}: ${random()} §` }],
        }));
        const hostPath =
            host === "oc1" ? join(root.dir, "opencode", "opencode.db") : join(root.dir, "host.db");
        mkdirSync(join(root.dir, "opencode"));
        const store = new Database(hostPath);
        if (host === "oc1") {
            store.exec(
                "CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT); CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT)",
            );
            const insert = store.prepare("INSERT INTO message VALUES (?, ?, ?, ?, ?)");
            source.forEach((message, index) => {
                insert.run(
                    message.info.id!,
                    sessionId,
                    Math.floor(index / 3),
                    index,
                    JSON.stringify(message.info),
                );
            });
        } else {
            store.exec(
                "CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT, seq INTEGER, type TEXT, data TEXT, time_created INTEGER DEFAULT 0, time_updated INTEGER DEFAULT 0)",
            );
            const insert = store.prepare(
                "INSERT INTO session_message (id, session_id, seq, type, data) VALUES (?, ?, ?, ?, ?)",
            );
            source.forEach((message, index) => {
                insert.run(
                    message.info.id!,
                    sessionId,
                    index * 7 + 1,
                    "user",
                    JSON.stringify({ text: `row ${index}` }),
                );
            });
        }
        store.close();
        const provider = {
            readMessages: () => {
                throw new Error("in-order trim must not load full history");
            },
            ...createV2RawMessageProvider(
                createV2RawMessageReader(() => new V2StoreReader(hostPath)),
                sessionId,
            ),
        };
        const hash = createHash("sha256");
        let cases = 0;
        try {
            const run = () => {
                for (let sample = 0; sample < 128; sample++) {
                    const boundaryIndex = 1 + Math.floor(random() * 24);
                    const boundary = source[boundaryIndex]!.info.id!;
                    const partial = sample % 3 === 0;
                    replaceAllCompartments(db, sessionId, [
                        {
                            sequence: 1,
                            startMessage: 1,
                            endMessage: boundaryIndex + 1,
                            startMessageId: source[0]!.info.id!,
                            endMessageId: boundary,
                            ...(partial ? { endBlockIndex: 0 } : {}),
                            title: "Covered",
                            content: "summary",
                        },
                    ]);
                    const window = source.filter(
                        (_, index) => index === boundaryIndex || random() > 0.3,
                    );
                    const preparedPrefix: InjectM0M1Result = {
                        injected: true,
                        prependedMessageCount: 0,
                        m0RematerializedThisPass: false,
                        materializationContentionRetryExhausted: false,
                        decision: { value: false, reason: "cache_hit" },
                        m0Bytes: Buffer.from("fixed summary"),
                        m1Text: "fixed delta",
                        preparedMessages: [
                            {
                                info: { role: "user", sessionID: sessionId },
                                parts: [{ type: "text", text: "fixed summary", synthetic: true }],
                            },
                        ],
                        preparedTrimBoundaryId: boundary,
                    };
                    // Expected survivors come from the input window and the declared
                    // summarized range, never from a second run of the implementation.
                    const expected = window.filter(
                        (message) =>
                            source.indexOf(message) > boundaryIndex ||
                            (partial && message.info.id === boundary),
                    );
                    for (const snapshot of [false, true])
                        for (const bust of [false, true]) {
                            const messages = structuredClone(window);
                            const result = injectM0M1({
                                db,
                                sessionId,
                                state,
                                messages,
                                preparedPrefix,
                                prefixTrimSourceOrder: snapshot
                                    ? capturePrefixTrimSourceOrder(window)
                                    : undefined,
                                isCacheBustingPass: bust,
                            });
                            expect(result.prefixTrimStatus).toBe("applied");
                            expect(messages.slice(1)).toEqual(expected);
                            hash.update(JSON.stringify(messages));
                            cases++;
                        }
                }
                const withoutBoundary = source.filter((_, index) => index !== 10);
                const refusalCases: Array<[string, MessageLike[]]> = [
                    ["msg_missing", source],
                    [
                        source[10]!.info.id!,
                        [
                            ...withoutBoundary,
                            {
                                info: { id: "msg_unknown", role: "user", sessionID: sessionId },
                                parts: [{ type: "text", text: "unknown" }],
                            },
                        ],
                    ],
                    [source[10]!.info.id!, [...withoutBoundary].reverse()],
                    [source[10]!.info.id!, [...withoutBoundary, withoutBoundary[0]!]],
                ];
                for (const [boundary, window] of refusalCases) {
                    const messages = structuredClone([...window]);
                    const result = injectM0M1({
                        db,
                        sessionId,
                        state,
                        messages,
                        preparedPrefix: {
                            injected: true,
                            prependedMessageCount: 0,
                            m0RematerializedThisPass: false,
                            materializationContentionRetryExhausted: false,
                            decision: { value: false, reason: "cache_hit" },
                            m0Bytes: null,
                            m1Text: null,
                            preparedMessages: [],
                            preparedTrimBoundaryId: boundary,
                        },
                        prefixTrimSourceOrder: capturePrefixTrimSourceOrder(window),
                    });
                    expect(result.prefixTrimStatus).toBe("refused");
                    expect(messages).toEqual([...window]);
                    hash.update(JSON.stringify(messages));
                }
            };
            if (host === "oc1") run();
            else withRawMessageProvider(sessionId, provider, run);
            console.log(
                `ISSUE_702_DIFFERENTIAL ${host} cases=${cases} refusals=4 sha256=${hash.digest("hex")}`,
            );
        } finally {
            closeReadOnlySessionDb();
            resetPrefixTrimFallbackState(sessionId);
            db.close();
            if (priorDataHome === undefined) delete process.env.XDG_DATA_HOME;
            else process.env.XDG_DATA_HOME = priorDataHome;
            root.cleanup();
        }
    });
}
