import { expect, test } from "bun:test";
import { join } from "node:path";
import { appendCompartments } from "../../features/magic-context/compartment-storage";
import { getOrCreateSessionMeta } from "../../features/magic-context/storage";
import { initializeDatabase } from "../../features/magic-context/storage-db";
import { Database } from "../../shared/sqlite";
import { createTestTempDir } from "../../shared/test-temp-dir";
import { restoreRow } from "../../v2/fold/restore";
import {
    createV2RawMessageProvider,
    createV2RawMessageReader,
    rawMessages,
} from "../../v2/hooks/store";
import { type StoreRow, V2StoreReader } from "../../v2/store-reader";
import {
    capturePrefixTrimSourceOrder,
    clearInjectionCache,
    injectM0M1,
    type M0M1State,
    resetPrefixTrimFallbackState,
} from "./inject-compartments";
import { withRawMessageProvider } from "./read-session-chunk";
import type { MessageLike } from "./tag-messages";

const SESSION = "issue-702-review";
const INSTRUCTION = "UNSUMMARIZED: never publish the private signing key.";
const model = { providerID: "review", id: "fixture" };

/** Render OpenCode 2 rows, whose instruction updates lose their IDs on the wire. */
function render(rows: readonly StoreRow[], omitted: readonly string[] = []): MessageLike[] {
    return rows
        .filter((row) => !omitted.includes(row.id))
        .flatMap((row) => restoreRow(row, model))
        .map((message) => ({
            info: { id: message.id, role: message.role, sessionID: SESSION },
            parts: message.content,
        })) as MessageLike[];
}

function fixture() {
    const root = createTestTempDir("issue-702-review-");
    const contextPath = join(root.dir, "context.db");
    let db = new Database(contextPath);
    initializeDatabase(db);
    getOrCreateSessionMeta(db, SESSION);
    const rows: StoreRow[] = [
        { id: "msg_z_old", session_id: SESSION, seq: 10, type: "user", data: { text: "OLD" } },
        // The seq=20 row is inserted and deleted below, leaving this boundary intact.
        { id: "msg_a_boundary", session_id: SESSION, seq: 30, type: "user", data: { text: "END" } },
        {
            id: "msg_system",
            session_id: SESSION,
            seq: 40,
            type: "system",
            data: { text: INSTRUCTION },
        },
        {
            id: "msg_notice",
            session_id: SESSION,
            seq: 45,
            type: "location-switched",
            data: { location: { directory: join(root.dir, "moved-project") } },
        },
        { id: "msg_b_tail", session_id: SESSION, seq: 60, type: "user", data: { text: "TAIL" } },
    ];
    const hostPath = join(root.dir, "host.db");
    const host = new Database(hostPath);
    host.exec(
        "CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT, seq INTEGER, type TEXT, data TEXT, time_created INTEGER DEFAULT 0, time_updated INTEGER DEFAULT 0)",
    );
    const insert = host.prepare(
        "INSERT INTO session_message (id, session_id, seq, type, data) VALUES (?, ?, ?, ?, ?)",
    );
    for (const row of rows)
        insert.run(row.id, row.session_id, row.seq, row.type, JSON.stringify(row.data));
    // Exercise deletion in SQLite rather than just manufacturing dense ordinals.
    insert.run("deleted", SESSION, 20, "user", JSON.stringify({ text: "deleted" }));
    host.prepare("DELETE FROM session_message WHERE id = ?").run("deleted");
    host.close();
    const reader = createV2RawMessageReader(() => new V2StoreReader(hostPath));
    const provider = {
        readMessages: () => rawMessages(rows),
        ...createV2RawMessageProvider(reader, SESSION),
    };
    appendCompartments(db, SESSION, [
        {
            sequence: 1,
            startMessage: 1,
            endMessage: 2,
            startMessageId: "msg_z_old",
            endMessageId: "msg_a_boundary",
            title: "Only the first two rows",
            content: "OLD and END were summarized.",
            p1: "OLD and END were summarized.",
            p2: "OLD and END were summarized.",
            p3: "OLD and END were summarized.",
        },
    ]);
    const pass = (source: MessageLike[], bust: boolean) => {
        const messages = structuredClone(source);
        const result = withRawMessageProvider(SESSION, provider, () =>
            injectM0M1({
                db,
                sessionId: SESSION,
                state: getOrCreateSessionMeta(db, SESSION) as unknown as M0M1State,
                messages,
                prefixTrimSourceOrder: capturePrefixTrimSourceOrder(source),
                isCacheBustingPass: bust,
                injectDocs: false,
                memoryEnabled: false,
                projectDirectory: root.dir,
                projectPath: root.dir,
                hardSignals: {
                    systemHash: "stable",
                    modelKey: "review/fixture",
                    cacheExpired: false,
                    lastResponseTime: 0,
                },
            }),
        );
        return { messages, result };
    };
    return {
        rows,
        pass,
        provider,
        restart() {
            db.close();
            clearInjectionCache(SESSION);
            resetPrefixTrimFallbackState(SESSION);
            db = new Database(contextPath);
        },
        close() {
            db.close();
            clearInjectionCache(SESSION);
            resetPrefixTrimFallbackState(SESSION);
            root.cleanup();
        },
    };
}

test("issue 702: an invisible seam must not eat an unsummarized interior system update", () => {
    const f = fixture();
    try {
        expect(f.provider.readMessageOrdinalById("msg_notice")).toBeNull();
        expect(f.provider.readMessageOrderById?.("msg_notice")).toBe(45);
        const { messages } = f.pass(render(f.rows, ["msg_a_boundary"]), true);
        expect(messages.filter((message) => message.info.role === "system")).toEqual(
            render([f.rows[2]!]),
        );
        expect(
            messages.filter((message) => message.info.id).map((message) => message.info.id),
        ).toEqual(["msg_notice", "msg_b_tail"]);
    } finally {
        f.close();
    }
});

test("issue 702: a head instruction after an invisible boundary is not covered by the summary", () => {
    const f = fixture();
    try {
        const { messages } = f.pass(render(f.rows.slice(2)), true);
        expect(messages.filter((message) => message.info.role === "system")).toEqual(
            render([f.rows[2]!]),
        );
    } finally {
        f.close();
    }
});

for (const restart of [false, true]) {
    test(`issue 702: first reanchor on defer preserves the already served bytes${restart ? " after restart" : ""}`, () => {
        const f = fixture();
        try {
            // This priced request was served successfully, not refused. Only the
            // boundary vanishes from the next host window; the update stays live.
            const priced = f.pass(render(f.rows), true);
            expect(priced.result.prefixTrimStatus).toBe("applied");
            expect(JSON.stringify(priced.messages)).toContain(INSTRUCTION);
            if (restart) f.restart();
            const defer = f.pass(render(f.rows, ["msg_a_boundary"]), false);
            expect(defer.result.m0RematerializedThisPass).toBe(false);
            expect(defer.result.m0Bytes).toEqual(priced.result.m0Bytes);
            expect(defer.result.m1Text).toBe(priced.result.m1Text);
            expect(JSON.stringify(defer.messages)).toBe(JSON.stringify(priced.messages));
        } finally {
            f.close();
        }
    });
}

test("issue 702 control: visible boundary preserves the unsummarized instruction and notice exactly once", () => {
    const f = fixture();
    try {
        const priced = f.pass(render(f.rows), true);
        const defer = f.pass(render(f.rows), false);
        expect(priced.result.prefixTrimStatus).toBe("applied");
        expect(priced.messages.slice(priced.result.prependedMessageCount)).toEqual(
            render(f.rows.slice(2)),
        );
        expect(defer.messages).toEqual(priced.messages);
    } finally {
        f.close();
    }
});
