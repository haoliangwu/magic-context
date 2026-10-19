/// <reference types="bun-types" />

import { Database as UnwrappedDatabase } from "bun:sqlite";
import { describe, expect, it, spyOn } from "bun:test";
import { join } from "node:path";
import { prewarmTagOwners } from "../../hooks/magic-context/tag-owner-warmup";
import { Database, getTagIdentityWriteGeneration, mayChangeTagIdentity } from "../../shared/sqlite";
import { contentTagOwnerMessageId } from "../../shared/tag-owner-id";
import { createTestTempDir } from "../../shared/test-temp-dir";
import { runMigrations } from "./migrations";
import { initializeDatabase } from "./storage-db";
import { deleteSessionScopedRows } from "./storage-session-tables";
import {
    installTagIdentityRevisionTrigger,
    tagIdentityRevisionKey,
} from "./storage-tag-identity-revision";
import {
    backfillTagTokenCounts,
    deleteTagsByMessageId,
    getMaxTagNumberByOwnerMessage,
    getReasoningTokenEstimatesByMessage,
    getTagOwnerRowsReadForTest,
    getTagOwnerShapeChecksForTest,
    getTagsBySession,
    insertTag,
    installTagOwnerDelta,
    isTagOwnerSummaryReady,
    resetTagOwnerRowsReadForTest,
    scanTagOwnerDelta,
    TAG_OWNER_APPENDED_WITH_SHAPE_SQL,
    TagOwnerSummaryNotReady,
    tagOwnerWarmupState,
    updateTagDropMode,
    updateTagStatus,
} from "./storage-tags";

const SESSION = "ses-tags";

/**
 * Highest tag number per owning message, read from every tag of the session:
 * a tool tag counts for its tool owner message (skipped without one), any other
 * tag for the message its content id names. This is how
 * projectOpencodeReasoningBudgetCutoff grouped tags before the summary cache.
 */
function frozenMaxTagByOwner(db: Database, sessionId: string): Map<string, number> {
    const maxTags = new Map<string, number>();
    for (const tag of getTagsBySession(db, sessionId)) {
        const id =
            tag.type === "tool" ? tag.toolOwnerMessageId : contentTagOwnerMessageId(tag.messageId);
        if (id) maxTags.set(id, Math.max(maxTags.get(id) ?? 0, tag.tagNumber));
    }
    return maxTags;
}

/**
 * Reasoning token estimate per owning message (the largest message-tag count
 * times the prose ratio), computed with the full-session statement that
 * getReasoningTokenEstimatesByMessage ran before the summary cache.
 */
function frozenReasoningEstimates(
    db: Database,
    sessionId: string,
    proseRatio: number,
): Map<string, number> {
    const rows = db
        .prepare(
            "SELECT type, message_id, tool_owner_message_id, reasoning_token_count FROM tags WHERE session_id = ? AND reasoning_token_count IS NOT NULL",
        )
        .all(sessionId) as Array<{
        type: string;
        message_id: string;
        reasoning_token_count: number;
    }>;
    const totals = new Map<string, number>();
    for (const row of rows) {
        if (row.type !== "message") continue;
        const id = contentTagOwnerMessageId(row.message_id);
        totals.set(id, Math.max(totals.get(id) ?? 0, row.reasoning_token_count * proseRatio));
    }
    return totals;
}

async function expectMatchesFullRead(db: Database, ratio = 0.75): Promise<void> {
    expect(await prewarmTagOwners(db, SESSION, ratio)).toBe(true);
    // Estimates first, as the projection reads them, then the owner map.
    expect(new Map(getReasoningTokenEstimatesByMessage(db, SESSION, ratio))).toEqual(
        frozenReasoningEstimates(db, SESSION, ratio),
    );
    expect(new Map(getMaxTagNumberByOwnerMessage(db, SESSION))).toEqual(
        frozenMaxTagByOwner(db, SESSION),
    );
}

function addTag(
    db: Database,
    tagNumber: number,
    messageId: string,
    type: "message" | "tool" | "file",
    reasoning: number | null = null,
    toolOwner: string | null = null,
): void {
    insertTag(
        db,
        SESSION,
        messageId,
        type,
        10,
        tagNumber,
        0,
        type === "tool" ? "read" : null,
        0,
        toolOwner,
        null,
        reasoning === null
            ? null
            : { tokenCount: 5, inputTokenCount: 0, reasoningTokenCount: reasoning },
    );
}

describe("tag owner summary", async () => {
    it("matches a full read through appends, owner changes, removals and other connections", async () => {
        const { dir: directory, cleanup } = createTestTempDir("mc-tag-owner-");
        const path = join(directory, "context.db");
        const db = new Database(path);
        // A connection opened without Magic Context's wrapper stands in for
        // another process: its writes reach this process only as a commit.
        let other: UnwrappedDatabase | undefined;
        try {
            initializeDatabase(db);
            addTag(db, 1, "m-1", "message", 40);
            addTag(db, 2, "m-1:p1", "message", 90);
            addTag(db, 3, "call-1", "tool", null, "m-1");
            addTag(db, 4, "call-2", "tool");
            addTag(db, 5, "m-2", "file");
            await expectMatchesFullRead(db);

            // Appends are folded into the cached summary. Tag 6 is written before
            // its token columns exist, the way a legacy row is.
            addTag(db, 6, "m-3", "message", null);
            addTag(db, 7, "call-3", "tool", null, "m-3");
            await expectMatchesFullRead(db);
            // A prose ratio the summary has not seen yet must still match a full read.
            await expectMatchesFullRead(db, 1.5);

            // A reasoning count written later changes an existing row.
            backfillTagTokenCounts(db, SESSION, 6, {
                tokenCount: 5,
                inputTokenCount: 0,
                reasoningTokenCount: 300,
            });
            await expectMatchesFullRead(db);

            // A removal lowers an owner's maximum.
            deleteTagsByMessageId(db, SESSION, "m-3");
            await expectMatchesFullRead(db);

            // An owner re-assignment through this process's connection.
            db.prepare(
                "UPDATE tags SET tool_owner_message_id = ? WHERE session_id = ? AND tag_number = ?",
            ).run("m-2", SESSION, 4);
            await expectMatchesFullRead(db);

            // A commit by another process, invisible to this process's write count.
            other = new UnwrappedDatabase(path);
            other.exec("PRAGMA busy_timeout = 1000");
            other
                .prepare("DELETE FROM tags WHERE session_id = ? AND tag_number = ?")
                .run(SESSION, 2);
            await expectMatchesFullRead(db);

            // Rows read inside a transaction that rolls back never reach the cache.
            db.exec("BEGIN IMMEDIATE");
            addTag(db, 8, "m-9", "message", 999);
            expect(() => getMaxTagNumberByOwnerMessage(db, SESSION)).toThrow(
                TagOwnerSummaryNotReady,
            );
            db.exec("ROLLBACK");
            await expectMatchesFullRead(db);
        } finally {
            other?.close();
            db.close();
            cleanup();
        }
    });

    it("reads only the appended tag rows, however many tags the session has", async () => {
        const rowsReadFor = async (tagCount: number): Promise<number> => {
            const db = new Database(":memory:");
            try {
                initializeDatabase(db);
                db.transaction(() => {
                    for (let tag = 1; tag <= tagCount; tag += 1) {
                        addTag(
                            db,
                            tag,
                            `m-${tag}`,
                            tag % 3 === 0 ? "tool" : "message",
                            tag,
                            `m-${tag - 1}`,
                        );
                    }
                })();
                getReasoningTokenEstimatesByMessage(db, SESSION, 1);
                getMaxTagNumberByOwnerMessage(db, SESSION);
                for (let tag = tagCount + 1; tag <= tagCount + 3; tag += 1) {
                    addTag(db, tag, `m-${tag}`, "message", tag);
                }
                resetTagOwnerRowsReadForTest();
                getReasoningTokenEstimatesByMessage(db, SESSION, 1);
                getMaxTagNumberByOwnerMessage(db, SESSION);
                const read = getTagOwnerRowsReadForTest();
                await expectMatchesFullRead(db, 1);
                return read;
            } finally {
                db.close();
            }
        };
        expect(await rowsReadFor(2_000)).toBe(3);
        expect(await rowsReadFor(20_000)).toBe(3);
    });
});

describe("tag owner summary after other connections' commits", async () => {
    /**
     * A file store with tags 1..count and a warm summary. `other` stands in for
     * another process: a connection without Magic Context's wrapper, whose
     * writes reach this process only as a commit (`data_version` moves).
     */
    /**
     * `other` is a Magic Context connection of another process by default: it
     * installs the identity-revision trigger every Magic Context connection
     * installs when it opens. `magicContextWriter: false` leaves it a raw
     * connection that is not Magic Context's.
     */
    async function withForeignWriter(
        count: number,
        run: (db: Database, other: UnwrappedDatabase) => Promise<void>,
        magicContextWriter = true,
    ): Promise<void> {
        const { dir: directory, cleanup } = createTestTempDir("mc-tag-owner-foreign-");
        const path = join(directory, "context.db");
        const db = new Database(path);
        let other: UnwrappedDatabase | undefined;
        try {
            initializeDatabase(db);
            db.transaction(() => {
                for (let tag = 1; tag <= count; tag += 1)
                    addTag(
                        db,
                        tag,
                        `m-${tag}`,
                        tag % 3 === 0 ? "tool" : "message",
                        tag,
                        `m-${tag - 1}`,
                    );
            })();
            await expectMatchesFullRead(db, 1);
            other = new UnwrappedDatabase(path);
            other.exec("PRAGMA busy_timeout = 1000");
            if (magicContextWriter) installTagIdentityRevisionTrigger(other as unknown as Database);
            await run(db, other);
        } finally {
            other?.close();
            db.close();
            cleanup();
        }
    }

    async function readCost(db: Database): Promise<{ rows: number; checks: number }> {
        resetTagOwnerRowsReadForTest();
        expect(await prewarmTagOwners(db, SESSION, 1)).toBe(true);
        getReasoningTokenEstimatesByMessage(db, SESSION, 1);
        getMaxTagNumberByOwnerMessage(db, SESSION);
        return { rows: getTagOwnerRowsReadForTest(), checks: getTagOwnerShapeChecksForTest() };
    }

    it("folds tags another connection appended without rereading the session", async () => {
        for (const count of [2_000, 20_000]) {
            await withForeignWriter(count, async (db, other) => {
                const insert = other.prepare(
                    "INSERT INTO tags (session_id, message_id, type, byte_size, tag_number, reasoning_token_count) VALUES (?, ?, 'message', 10, ?, ?)",
                );
                for (let tag = count + 1; tag <= count + 3; tag += 1)
                    insert.run(SESSION, `m-${tag}`, tag, tag * 2);
                // One shape check, then only the three new rows.
                expect({ count, ...(await readCost(db)) }).toEqual({ count, rows: 3, checks: 1 });
                await expectMatchesFullRead(db, 1);
            });
        }
    });

    it("keeps the summary through status and drop writes on either connection", async () => {
        await withForeignWriter(2_000, async (db, other) => {
            updateTagStatus(db, SESSION, 5, "dropped");
            updateTagDropMode(db, SESSION, 5, "truncated");
            expect(await readCost(db)).toEqual({ rows: 0, checks: 0 });
            other
                .prepare(
                    "UPDATE tags SET status = 'dropped', drop_mode = 'full' WHERE session_id = ? AND tag_number <= 100",
                )
                .run(SESSION);
            expect(await readCost(db)).toEqual({ rows: 0, checks: 1 });
            await expectMatchesFullRead(db, 1);
        });
    });

    it("rebuilds after another connection deletes or replaces a tag", async () => {
        await withForeignWriter(2_000, async (db, other) => {
            other
                .prepare("DELETE FROM tags WHERE session_id = ? AND tag_number = 1999")
                .run(SESSION);
            expect(await readCost(db)).toEqual({ rows: 0, checks: 2 });
            await expectMatchesFullRead(db, 1);
            // Delete and append in one commit: the count alone would not move.
            other.transaction(() => {
                other
                    .prepare("DELETE FROM tags WHERE session_id = ? AND tag_number = 1998")
                    .run(SESSION);
                other
                    .prepare(
                        "INSERT INTO tags (session_id, message_id, type, byte_size, tag_number) VALUES (?, 'm-new', 'message', 10, 3000)",
                    )
                    .run(SESSION);
            })();
            expect(await readCost(db)).toEqual({ rows: 0, checks: 2 });
            await expectMatchesFullRead(db, 1);
            // A REPLACE removes the old row without a delete trigger.
            other
                .prepare(
                    "INSERT OR REPLACE INTO tags (session_id, message_id, type, byte_size, tag_number) VALUES (?, 'm-replaced', 'message', 10, 7)",
                )
                .run(SESSION);
            expect((await readCost(db)).rows).toBe(0);
            await expectMatchesFullRead(db, 1);
        });
    });

    it("rebuilds after another Magic Context connection re-keys or backfills a tag in place", async () => {
        await withForeignWriter(2_000, async (db, other) => {
            other
                .prepare(
                    "UPDATE tags SET message_id = 'm-rekeyed' WHERE session_id = ? AND tag_number = 1000",
                )
                .run(SESSION);
            expect(await readCost(db)).toEqual({ rows: 0, checks: 2 });
            await expectMatchesFullRead(db, 1);
            other
                .prepare(
                    "UPDATE tags SET reasoning_token_count = 5000 WHERE session_id = ? AND tag_number = 10",
                )
                .run(SESSION);
            expect(await readCost(db)).toEqual({ rows: 0, checks: 2 });
            await expectMatchesFullRead(db, 1);
        });
    });

    it("documents the residual: an in-place re-key by a connection that is not Magic Context's keeps the cached owners", async () => {
        await withForeignWriter(
            2_000,
            async (db, other) => {
                other
                    .prepare(
                        "UPDATE tags SET message_id = 'm-rekeyed' WHERE session_id = ? AND tag_number = 1000",
                    )
                    .run(SESSION);
                // The raw connection does not bump the identity revision and the
                // count and highest id are unchanged, so the summary is kept. The
                // same re-key on this process's own connection moves its
                // identity-write generation and rebuilds.
                expect(await readCost(db)).toEqual({ rows: 0, checks: 1 });
                expect(getMaxTagNumberByOwnerMessage(db, SESSION).get("m-rekeyed")).toBeUndefined();
                db.prepare(
                    "UPDATE tags SET message_id = 'm-rekeyed' WHERE session_id = ? AND tag_number = 1000",
                ).run(SESSION);
                expect((await readCost(db)).rows).toBe(0);
                await expectMatchesFullRead(db, 1);
            },
            false,
        );
    });

    it("installs the identity-revision trigger on every initialized connection", async () => {
        const db = new Database(":memory:");
        try {
            initializeDatabase(db);
            expect(
                db
                    .prepare(
                        "SELECT name FROM sqlite_temp_master WHERE type = 'trigger' AND name = 'mc_tag_identity_revision_au'",
                    )
                    .get(),
            ).toEqual({ name: "mc_tag_identity_revision_au" });
        } finally {
            db.close();
        }
    });

    it("checks a warm session's shape using only the covering index", async () => {
        await withForeignWriter(10, async (db, other) => {
            other.prepare("UPDATE tags SET status = 'dropped' WHERE session_id = ?").run(SESSION);
            const statements: string[] = [];
            const prepare = db.prepare.bind(db);
            db.prepare = ((sql: string) => {
                statements.push(sql);
                return prepare(sql);
            }) as typeof db.prepare;
            try {
                expect((await readCost(db)).checks).toBe(1);
            } finally {
                db.prepare = prepare;
            }
            expect(statements.some((sql) => sql.includes("COUNT(*)"))).toBe(true);
            const shape = TAG_OWNER_APPENDED_WITH_SHAPE_SQL;
            const plan = (
                db
                    .prepare(`EXPLAIN QUERY PLAN ${shape}`)
                    .all(0, SESSION, `revision:${SESSION}`, SESSION) as Array<{
                    detail: string;
                }>
            ).map((row) => row.detail);
            // The appended rows come from the rowid range, the count and highest
            // id from an index without visiting the table.
            expect(plan.join(" | ")).toMatch(/SEARCH tags USING INTEGER PRIMARY KEY \(rowid>\?\)/);
            expect(plan.join(" | ")).toMatch(
                /SEARCH tags USING COVERING INDEX \w+ \(session_id=\?\)/,
            );
            expect(plan.join(" | ")).not.toMatch(/SCAN tags/);
        });
    });
});

describe("tag identity write classification", async () => {
    it("lets appends and identity-free updates keep the summary", async () => {
        for (const sql of [
            "INSERT INTO tags (session_id, message_id, type, byte_size, tag_number) VALUES (?, ?, ?, ?, ?)",
            "UPDATE tags SET status = ? WHERE session_id = ? AND tag_number = ?",
            "UPDATE tags SET drop_mode = ? WHERE session_id = ? AND tag_number = ?",
            "UPDATE tags SET token_count = MAX(COALESCE(token_count, 0), ?) WHERE session_id = ? AND tag_number = ?",
            "UPDATE tags\n SET byte_size = ?,\n reasoning_byte_size = ?,\n input_byte_size = ?\n WHERE session_id = ?",
            "UPDATE tags SET status = 'a, message_id = b', drop_mode = ? WHERE id = ?",
            "SELECT * FROM tags",
            "UPDATE notes SET content = ? WHERE id = ?",
            "DELETE FROM message_tags WHERE id = ?",
        ]) {
            expect({ sql, changes: mayChangeTagIdentity(sql) }).toEqual({ sql, changes: false });
        }
    });

    it("treats anything that can change or remove an existing tag as an identity write", async () => {
        for (const sql of [
            "DELETE FROM tags WHERE session_id = ? AND tag_number = ?",
            "UPDATE tags SET message_id = ? WHERE session_id = ? AND tag_number = ?",
            "UPDATE tags SET tool_owner_message_id = ? WHERE id = ? AND tool_owner_message_id IS NULL",
            "UPDATE tags SET status = 'compacted', message_id = ?, entry_fingerprint = ? WHERE id = ?",
            "UPDATE tags SET token_count = CASE WHEN ? IS NOT NULL THEN MAX(COALESCE(token_count, 0), ?) ELSE token_count END, input_token_count = ?, reasoning_token_count = ? WHERE session_id = ?",
            "UPDATE tags SET status = ?",
            "UPDATE tags SET status = 'dropped', (tag_number, reasoning_token_count) = (6, 1000) WHERE id = ?",
            "UPDATE tags SET status = 'unbalanced WHERE id = ?",
            "UPDATE tags SET status == 1 WHERE id = ?",
            "UPDATE tags SET status = (SELECT 'x' WHERE 1) , message_id = ? WHERE id = ?",
            "INSERT OR REPLACE INTO tags (session_id, tag_number) VALUES (?, ?)",
            "INSERT INTO tags (id, session_id, tag_number) VALUES (?, ?, ?)",
            "INSERT INTO tags (session_id, tag_number) VALUES (?, ?) ON CONFLICT(session_id, tag_number) DO UPDATE SET message_id = excluded.message_id",
            "INSERT INTO tags (session_id) VALUES (?); DELETE FROM tags WHERE id = 1",
            "WITH doomed AS (SELECT id FROM tags) DELETE FROM tags WHERE id IN doomed",
            "DROP TABLE tags",
            "ALTER TABLE tags ADD COLUMN extra TEXT",
        ]) {
            expect({ sql, changes: mayChangeTagIdentity(sql) }).toEqual({ sql, changes: true });
        }
    });
});

describe("tag identity revision rows on session deletion", async () => {
    const revisionOf = (db: Database, sessionId: string) => {
        const value = (
            db
                .prepare("SELECT value FROM schema_migrations_meta WHERE key = ?")
                .get(tagIdentityRevisionKey(sessionId)) as { value: string } | null
        )?.value;
        return value?.split(":").at(-1) ?? null;
    };

    it("removes permanent tombstones but advances epochs while another harness's tags remain", async () => {
        const db = new Database(":memory:");
        try {
            initializeDatabase(db);
            runMigrations(db);
            addTag(db, 1, "m-1", "message", 10);
            db.prepare(
                "INSERT INTO tags (session_id, message_id, type, byte_size, tag_number, harness) VALUES (?, 'm-2', 'message', 10, 2, 'pi')",
            ).run(SESSION);
            db.prepare("UPDATE tags SET reasoning_token_count = 20 WHERE session_id = ?").run(
                SESSION,
            );
            expect(revisionOf(db, SESSION)).toBe("2");
            // Only the opencode rows go; the surviving pi row retains an advanced epoch.
            expect(deleteSessionScopedRows(db, [SESSION], "opencode")).toBe(1);
            expect(revisionOf(db, SESSION)).toBe("3");
            expect(deleteSessionScopedRows(db, [SESSION])).toBe(1);
            expect(revisionOf(db, SESSION)).toBeNull();
        } finally {
            db.close();
        }
    });

    it("rebuilds a warm summary of a session deleted by another connection", async () => {
        const { dir: directory, cleanup } = createTestTempDir("mc-tag-owner-delete-");
        const path = join(directory, "context.db");
        const db = new Database(path);
        let other: Database | undefined;
        try {
            initializeDatabase(db);
            runMigrations(db);
            addTag(db, 1, "m-1", "message", 10);
            addTag(db, 2, "m-2", "message", 30);
            db.prepare(
                "UPDATE tags SET reasoning_token_count = 40 WHERE session_id = ? AND tag_number = 1",
            ).run(SESSION);
            await expectMatchesFullRead(db, 1);
            expect(revisionOf(db, SESSION)).not.toBeNull();
            // Session cleanup on a second connection deletes the tags first and
            // then the revision row.
            other = new Database(path);
            deleteSessionScopedRows(other, [SESSION]);
            expect(revisionOf(db, SESSION)).toBeNull();
            // The missing revision differs from the cached one, and the count fell
            // to zero: either way the summary is rebuilt, not reused.
            resetTagOwnerRowsReadForTest();
            expect(await prewarmTagOwners(db, SESSION, 1)).toBe(true);
            expect(new Map(getMaxTagNumberByOwnerMessage(db, SESSION))).toEqual(new Map());
            expect(getTagOwnerShapeChecksForTest()).toBeLessThanOrEqual(1);
            await expectMatchesFullRead(db, 1);
        } finally {
            other?.close();
            db.close();
            cleanup();
        }
    });
});

describe("initial owner revision capture", () => {
    it("captures one indexed seed read on local append and still rejects a later identity rewrite", async () => {
        const { dir, cleanup } = createTestTempDir("mc-owner-initial-seed-");
        const path = join(dir, "context.db");
        const db = new Database(path);
        const peer = new UnwrappedDatabase(path);
        try {
            initializeDatabase(db);
            runMigrations(db);
            initializeDatabase(peer as unknown as Database);
            expect(await prewarmTagOwners(db, SESSION, 1)).toBe(true);
            expect(tagOwnerWarmupState(db, SESSION)?.identityRevision).toBeNull();
            const prepare = spyOn(db, "prepare");
            try {
                addTag(db, 1, "first:p0", "message");
                expect(isTagOwnerSummaryReady(db, SESSION, 1)).toBe(true);
                const seeded = tagOwnerWarmupState(db, SESSION)?.identityRevision;
                expect(seeded).toMatch(/^[1-9]\d*:0$/);
                expect(
                    prepare.mock.calls.filter(
                        ([sql]) => sql === "SELECT value FROM schema_migrations_meta WHERE key = ?",
                    ),
                ).toHaveLength(1);
                addTag(db, 2, "second:p0", "message");
                expect(isTagOwnerSummaryReady(db, SESSION, 1)).toBe(true);
                expect(isTagOwnerSummaryReady(db, SESSION, 1)).toBe(true);
                expect(
                    prepare.mock.calls.filter(
                        ([sql]) => sql === "SELECT value FROM schema_migrations_meta WHERE key = ?",
                    ),
                ).toHaveLength(1);
            } finally {
                prepare.mockRestore();
            }
            peer.prepare(
                "INSERT OR REPLACE INTO schema_migrations_meta(key,value) VALUES ('unrelated-owner-metadata','1')",
            ).run();
            expect(isTagOwnerSummaryReady(db, SESSION, 1)).toBe(true);
            const seeded = tagOwnerWarmupState(db, SESSION)?.identityRevision;
            peer.prepare(
                "UPDATE tags SET message_id='rewritten:p0',reasoning_token_count=20 WHERE session_id=? AND tag_number=1",
            ).run(SESSION);
            expect(isTagOwnerSummaryReady(db, SESSION, 1)).toBe(false);
            expect(tagOwnerWarmupState(db, SESSION)?.identityRevision).toBe(seeded);
            expect(await prewarmTagOwners(db, SESSION, 1)).toBe(true);
            expect(new Map(getMaxTagNumberByOwnerMessage(db, SESSION))).toEqual(
                new Map([
                    ["rewritten", 1],
                    ["second", 2],
                ]),
            );
            expect(new Map(getReasoningTokenEstimatesByMessage(db, SESSION, 1))).toEqual(
                new Map([["rewritten", 20]]),
            );
        } finally {
            peer.close();
            db.close();
            cleanup();
        }
    });

    it("worker delta rejects null-to-seed changes and full warmup installs the seed", async () => {
        const { dir, cleanup } = createTestTempDir("mc-owner-worker-seed-");
        const path = join(dir, "context.db");
        const db = new Database(path);
        const peer = new UnwrappedDatabase(path);
        try {
            initializeDatabase(db);
            runMigrations(db);
            initializeDatabase(peer as unknown as Database);
            expect(await prewarmTagOwners(db, SESSION, 1)).toBe(true);
            const state = tagOwnerWarmupState(db, SESSION);
            if (!state) throw new Error("missing empty owner summary");
            expect(state.identityRevision).toBeNull();
            addTag(db, 1, "seeded:p0", "message");
            peer.prepare(
                "INSERT OR REPLACE INTO schema_migrations_meta(key,value) VALUES ('worker-peer-metadata','1')",
            ).run();
            expect(scanTagOwnerDelta(peer as unknown as Database, SESSION, state)).toBeNull();
            expect(await prewarmTagOwners(db, SESSION, 1)).toBe(true);
            expect(tagOwnerWarmupState(db, SESSION)?.identityRevision).toMatch(/^[1-9]\d*:0$/);
            expect(isTagOwnerSummaryReady(db, SESSION, 1)).toBe(true);
        } finally {
            peer.close();
            db.close();
            cleanup();
        }
    });

    it("installed legacy null-revision deltas capture the seed on the next own append", async () => {
        const { dir, cleanup } = createTestTempDir("mc-owner-null-delta-");
        const path = join(dir, "context.db");
        const db = new Database(path);
        const peer = new UnwrappedDatabase(path);
        try {
            initializeDatabase(db);
            runMigrations(db);
            expect(await prewarmTagOwners(db, SESSION, 1)).toBe(true);
            const state = tagOwnerWarmupState(db, SESSION);
            if (!state) throw new Error("missing empty owner summary");
            // This connection intentionally lacks TEMP observers, so its rows
            // exercise the existing null-revision delta path without seeding.
            peer.prepare(
                "INSERT INTO tags(session_id,message_id,type,status,tag_number,byte_size,harness) VALUES (?, 'legacy:p0','message','active',1,10,'opencode')",
            ).run(SESSION);
            const delta = scanTagOwnerDelta(peer as unknown as Database, SESSION, state);
            if (!delta) throw new Error("expected legacy append delta");
            const versions = db
                .prepare(
                    "SELECT data_version AS dataVersion, (SELECT schema_version FROM pragma_schema_version) AS schemaVersion FROM pragma_data_version",
                )
                .get() as { dataVersion: number; schemaVersion: number };
            expect(
                installTagOwnerDelta(db, SESSION, state, delta, {
                    ...versions,
                    generation: getTagIdentityWriteGeneration(),
                }),
            ).toBe(true);
            expect(tagOwnerWarmupState(db, SESSION)?.identityRevision).toBeNull();
            addTag(db, 2, "own:p0", "message");
            expect(isTagOwnerSummaryReady(db, SESSION, 1)).toBe(true);
            expect(tagOwnerWarmupState(db, SESSION)?.identityRevision).toMatch(/^[1-9]\d*:0$/);
            peer.prepare(
                "INSERT OR REPLACE INTO schema_migrations_meta(key,value) VALUES ('delta-peer-metadata','1')",
            ).run();
            expect(isTagOwnerSummaryReady(db, SESSION, 1)).toBe(true);
            expect(new Map(getMaxTagNumberByOwnerMessage(db, SESSION))).toEqual(
                new Map([
                    ["legacy", 1],
                    ["own", 2],
                ]),
            );
        } finally {
            peer.close();
            db.close();
            cleanup();
        }
    });
});
