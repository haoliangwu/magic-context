import { expect, spyOn, test } from "bun:test";
import {
    getOrCreateSessionMeta,
    markProtectedTailPolicyV3Seeded,
} from "../../features/magic-context/storage";
import { initializeDatabase } from "../../features/magic-context/storage-db";
import {
    insertTag,
    markWhitespaceAssistantTagInert,
} from "../../features/magic-context/storage-tags";
import { createTagger } from "../../features/magic-context/tagger";
import { Database } from "../../shared/sqlite";
import { applyFlushedStatuses } from "./apply-operations";
import { checkCompartmentTrigger } from "./compartment-trigger";
import { type MessageLike, tagMessages } from "./tag-messages";

function countTagRows(db: Database) {
    let rows = 0;
    const prepare = db.prepare.bind(db);
    const spy = spyOn(db, "prepare").mockImplementation((sql) => {
        const statement = prepare(sql);
        if (!/FROM tags\b/i.test(sql)) return statement;
        return new Proxy(statement, {
            get(target, key) {
                if (key === "all")
                    return (...args: unknown[]) => {
                        const result = target.all(...args);
                        rows += result.length;
                        return result;
                    };
                const value = Reflect.get(target, key);
                return typeof value === "function" ? value.bind(target) : value;
            },
        });
    });
    return {
        rows: () => rows,
        reset: () => {
            rows = 0;
        },
        restore: () => spy.mockRestore(),
    };
}

function seedHistory(db: Database, session: string, inert: boolean) {
    const insert = db.prepare(`INSERT INTO tags
        (session_id, message_id, type, tag_number, status, byte_size, entry_fingerprint, token_count)
        VALUES (?, ?, 'message', ?, ?, 1, ?, 0)`);
    db.transaction(() => {
        for (let n = 1; n <= 100_000; n++) {
            insert.run(
                session,
                inert ? `__mc_whitespace_assistant_inert__:${n}` : `old-${n}:p0`,
                n,
                inert ? "compacted" : "dropped",
                inert ? `mc:whitespace-assistant:old-${n}:p0` : null,
            );
        }
    })();
}

test("whitespace replay reads only visible rows in a 100K-tag session, including new-message passes", () => {
    const db = new Database(":memory:");
    let counter: ReturnType<typeof countTagRows> | undefined;
    try {
        initializeDatabase(db);
        const session = "scale-whitespace";
        getOrCreateSessionMeta(db, session);
        seedHistory(db, session, true);
        // Use the production writer for the visible retired tag so the prefix
        // assertion tests its actual stored identity, not a hand-written substitute.
        insertTag(db, session, "visible:p0", "message", 1, 100_001);
        markWhitespaceAssistantTagInert(db, session, 100_001, "visible:p0");
        const tagger = createTagger();
        tagger.initFromDb(session, db, 100_001);
        counter = countTagRows(db);
        for (let pass = 0; pass < 3; pass++) {
            insertTag(db, session, `new-${pass}:p0`, "message", 10, 100_002 + pass);
            tagger.initFromDb(session, db, 100_001);
            counter.reset();
            const messages: MessageLike[] = [
                {
                    info: { id: "visible", role: "assistant", sessionID: session },
                    parts: [{ type: "text", text: " " }],
                },
                {
                    info: { id: `new-${pass}`, role: "user", sessionID: session },
                    parts: [{ type: "text", text: "new content" }],
                },
            ];
            tagMessages(session, messages, tagger, db);
            expect((messages[0].parts[0] as { text: string }).text).toContain("§100001§");
            expect(counter.rows()).toBeLessThan(20);
        }
    } finally {
        counter?.restore();
        db.close();
    }
});

test("anchored trigger reads only live owner rows in a 100K-tag session", () => {
    const db = new Database(":memory:");
    let counter: ReturnType<typeof countTagRows> | undefined;
    try {
        initializeDatabase(db);
        const session = "scale-trigger";
        const meta = getOrCreateSessionMeta(db, session);
        markProtectedTailPolicyV3Seeded(db, session, 1);
        seedHistory(db, session, false);
        insertTag(db, session, "visible:p0", "message", 1, 100_001, 0, null, 0, null, null, {
            tokenCount: 1,
            inputTokenCount: 0,
            reasoningTokenCount: 0,
        });
        counter = countTagRows(db);
        for (let pass = 0; pass < 3; pass++) {
            counter.reset();
            const result = checkCompartmentTrigger(
                db,
                session,
                meta,
                { percentage: 25, inputTokens: 50000 },
                25,
                65,
                6000,
                undefined,
                undefined,
                undefined,
                200000,
                {
                    messages: [
                        {
                            id: "visible",
                            ordinal: 1,
                            role: "user",
                            parts: [{ type: "text", text: "tiny" }],
                            version: null,
                        },
                    ],
                    absoluteMessageCount: 1,
                },
                100_001,
            );
            expect(result).toEqual({ shouldFire: false });
            expect(counter.rows()).toBeLessThan(20);
        }
    } finally {
        counter?.restore();
        db.close();
    }
});

test("flushed status fallback reads only visible drops in a 100K-tag session", () => {
    const db = new Database(":memory:");
    let counter: ReturnType<typeof countTagRows> | undefined;
    try {
        initializeDatabase(db);
        const session = "scale-flushed";
        getOrCreateSessionMeta(db, session);
        seedHistory(db, session, false);
        counter = countTagRows(db);
        const replacements: string[] = [];
        const targets = new Map([
            [
                100_000,
                {
                    setContent: (text: string) => {
                        replacements.push(text);
                        return true;
                    },
                },
            ],
        ]);
        expect(applyFlushedStatuses(session, db, targets)).toBe(true);
        expect(replacements).toEqual(["[dropped §100000§]"]);
        expect(counter.rows()).toBe(1);
    } finally {
        counter?.restore();
        db.close();
    }
});
