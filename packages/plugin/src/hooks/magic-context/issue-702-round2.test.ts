import { expect, test } from "bun:test";
import { appendCompartments } from "../../features/magic-context/compartment-storage";
import { getOrCreateSessionMeta } from "../../features/magic-context/storage";
import { initializeDatabase } from "../../features/magic-context/storage-db";
import { Database } from "../../shared/sqlite";
import {
    capturePrefixTrimSourceOrder,
    clearInjectionCache,
    injectM0M1,
    type M0M1State,
    resetPrefixTrimFallbackState,
} from "./inject-compartments";
import { withRawMessageProvider } from "./read-session-chunk";
import type { MessageLike } from "./tag-messages";

const SESSION = "issue-702-round2";
const row = (id: string): MessageLike => ({
    info: { id, role: "user", sessionID: SESSION },
    parts: [{ type: "text", text: id }],
});
const instruction = (): MessageLike => ({
    info: { role: "system", sessionID: SESSION },
    parts: [{ type: "text", text: "Always retain this host instruction verbatim." }],
});

function fixture() {
    const db = new Database(":memory:");
    initializeDatabase(db);
    getOrCreateSessionMeta(db, SESSION);
    appendCompartments(db, SESSION, [
        {
            sequence: 1,
            startMessage: 1,
            endMessage: 2,
            startMessageId: "old",
            endMessageId: "boundary",
            title: "Covered history",
            content: "Only ordinary historical content was summarized.",
        },
    ]);
    // Directory-change notices have persisted sequence keys for ordering, but
    // do not consume an ordinal in the raw-message numbering used by summaries.
    const order = ["old", "notice-before", "boundary", "notice-after", "tail"];
    const provider = {
        readMessages: () => [],
        readMessageOrdinalById: (id: string) =>
            ({ old: 1, boundary: 2, tail: 3 })[id as "old" | "boundary" | "tail"] ?? null,
        readMessageOrderById: (id: string) => (order.includes(id) ? order.indexOf(id) * 10 : null),
    };
    return {
        pass(source: MessageLike[], bust: boolean, capture: boolean) {
            const messages = structuredClone(source);
            const result = withRawMessageProvider(SESSION, provider, () =>
                injectM0M1({
                    db,
                    sessionId: SESSION,
                    state: getOrCreateSessionMeta(db, SESSION) as unknown as M0M1State,
                    messages,
                    prefixTrimSourceOrder: capture
                        ? capturePrefixTrimSourceOrder(source)
                        : undefined,
                    isCacheBustingPass: bust,
                    injectDocs: false,
                    memoryEnabled: false,
                }),
            );
            return { messages, result };
        },
        close() {
            db.close();
            clearInjectionCache(SESSION);
            resetPrefixTrimFallbackState(SESSION);
        },
    };
}

for (const capture of [true, false]) {
    for (const position of [
        "head",
        "covered interior",
        "uncovered interior",
        "trailing",
    ] as const) {
        test(`issue 702 uniform retention: ${position}, source snapshot=${capture}`, () => {
            const f = fixture();
            try {
                const source = [
                    row("old"),
                    row("notice-before"),
                    row("boundary"),
                    row("notice-after"),
                    row("tail"),
                ];
                const at = { head: 0, "covered interior": 2, "uncovered interior": 3, trailing: 5 }[
                    position
                ];
                source.splice(at, 0, instruction());
                // A visible seam must retain even an instruction in its covered
                // prefix. Otherwise hiding only the seam would change defer bytes.
                const visible = f.pass(source, true, capture);
                expect(visible.result.prefixTrimStatus).toBe("applied");
                const tail = visible.messages.slice(visible.result.prependedMessageCount);
                expect(tail.filter((message) => message.info.role === "system")).toEqual([
                    instruction(),
                ]);
                expect(
                    tail.filter((message) => message.info.id).map((message) => message.info.id),
                ).toEqual(["notice-after", "tail"]);

                const invisible = source.filter((message) => message.info.id !== "boundary");
                const defer = f.pass(invisible, false, capture);
                expect(defer.result.m0RematerializedThisPass).toBe(false);
                expect(JSON.stringify(defer.messages)).toBe(JSON.stringify(visible.messages));
                const priced = f.pass(invisible, true, capture);
                expect(JSON.stringify(priced.messages)).toBe(JSON.stringify(visible.messages));
            } finally {
                f.close();
            }
        });
    }
}

test("issue 702 identified system rows use their own coverage, not the unplaced-row exception", () => {
    const f = fixture();
    try {
        const covered = { ...instruction(), info: { ...instruction().info, id: "old" } };
        const uncovered = { ...instruction(), info: { ...instruction().info, id: "tail" } };
        const { messages, result } = f.pass([covered, uncovered], true, true);
        expect(result.prefixTrimStatus).toBe("applied");
        expect(messages.slice(result.prependedMessageCount)).toEqual([uncovered]);
    } finally {
        f.close();
    }
});
