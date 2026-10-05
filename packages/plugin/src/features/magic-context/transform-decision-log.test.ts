import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "../../shared/sqlite";
import { closeQuietly } from "../../shared/sqlite-helpers";
import { createTestTempDirFromPath } from "../../shared/test-temp-dir";
import { runMigrations } from "./migrations";
import { initializeDatabase } from "./storage-db";
import {
    __test,
    TRANSFORM_DECISIONS_RETENTION,
    writeRustTransformDecision,
} from "./transform-decision-log";

let dir: string;
let dbPath: string;
let db: Database;

beforeEach(() => {
    dir = createTestTempDirFromPath(join(tmpdir(), "mc-txn-decision-"));
    dbPath = join(dir, "context.db");
    db = new Database(dbPath);
    initializeDatabase(db);
    runMigrations(db);
    __test.reset();
});

afterEach(() => {
    closeQuietly(db);
    rmSync(dir, { recursive: true, force: true });
    __test.reset();
});

function baseRow(messageId: string, tsMs: number) {
    return {
        sessionId: "ses-1",
        harness: "opencode" as const,
        messageId,
        tsMs,
        decision: "execute" as const,
        materialized: true,
        materializeReason: "system_hash" as const,
        systemHashPrev: "system-hash-before",
        systemHashNew: "system-hash-after",
        m0ModelKeyPrev: null,
        m0ModelKeyNew: null,
        emergency: false,
        droppedTokens: 0,
        droppedCount: 0,
        inputTokens: 100,
        bustedThisPass: true,
    };
}

function rowCount(): number {
    return (
        db
            .prepare(
                "SELECT COUNT(*) AS c FROM transform_decisions WHERE session_id = 'ses-1' AND harness = 'opencode'",
            )
            .get() as { c: number }
    ).c;
}

describe("transform_decisions retention cap", () => {
    it("attributes a byte-identical expired Rust resend to its own execute ttl_idle decision", () => {
        writeRustTransformDecision({
            sessionId: "ses-1",
            decision: "SOFT+",
            materializeReason: "ttl_idle",
            inputTokens: 100,
            tsMs: 123,
        });
        expect(__test.getPending("ses-1")).toMatchObject({
            tsMs: 123,
            decision: "execute",
            materialized: false,
            materializeReason: "ttl_idle",
            bustedThisPass: true,
        });
        writeRustTransformDecision({
            sessionId: "ses-1",
            decision: "SOFT+",
            materializeReason: null,
            inputTokens: 100,
        });
        expect(__test.getPending("ses-1")).toMatchObject({
            decision: "defer",
            materialized: false,
            bustedThisPass: false,
        });
    });
    // The prune SQL is cap-agnostic (`LIMIT ?`), so we inject a tiny cap to
    // exercise it with a handful of rows. Writing the real 2000+ cap opened
    // that many fresh DB connections in a loop and timed out under CI load.
    // The override removes the flake without weakening the assertion.
    const TEST_CAP = 10;

    beforeEach(() => {
        __test.setRetentionForTests(TEST_CAP);
    });

    it("prunes to the newest cap rows per (session,harness)", () => {
        // Write cap + 5 rows with strictly increasing ts and distinct message ids.
        const total = TEST_CAP + 5;
        for (let i = 0; i < total; i++) {
            __test.writeRow(dbPath, baseRow(`msg-${i}`, 1000 + i));
        }
        expect(rowCount()).toBe(TEST_CAP);

        // The oldest (smallest ts) must be gone; the newest must remain.
        const oldest = db
            .prepare("SELECT 1 FROM transform_decisions WHERE message_id = 'msg-0'")
            .get();
        const newest = db
            .prepare(`SELECT 1 FROM transform_decisions WHERE message_id = 'msg-${total - 1}'`)
            .get();
        expect(oldest ?? null).toBeNull();
        expect(newest ?? null).not.toBeNull();
    });

    it("records the compared system hashes for a system_hash fold", () => {
        __test.writeRow(dbPath, baseRow("system-hash-fold", 1));

        expect(
            db
                .prepare(
                    `SELECT materialize_reason, system_hash_prev, system_hash_new,
                            m0_model_key_prev, m0_model_key_new
                     FROM transform_decisions WHERE message_id = 'system-hash-fold'`,
                )
                .get(),
        ).toEqual({
            materialize_reason: "system_hash",
            system_hash_prev: "system-hash-before",
            system_hash_new: "system-hash-after",
            m0_model_key_prev: null,
            m0_model_key_new: null,
        });
    });

    it("records no comparisons for a first_render fold", () => {
        __test.writeRow(dbPath, {
            ...baseRow("first-render-fold", 1),
            materializeReason: "first_render",
            systemHashPrev: null,
            systemHashNew: null,
        });

        expect(
            db
                .prepare(
                    `SELECT materialize_reason, system_hash_prev, system_hash_new,
                            m0_model_key_prev, m0_model_key_new,
                            m0_tool_set_hash_prev, m0_tool_set_hash_new
                     FROM transform_decisions WHERE message_id = 'first-render-fold'`,
                )
                .get(),
        ).toEqual({
            materialize_reason: "first_render",
            system_hash_prev: null,
            system_hash_new: null,
            m0_model_key_prev: null,
            m0_model_key_new: null,
            m0_tool_set_hash_prev: null,
            m0_tool_set_hash_new: null,
        });
    });

    it("does not attach comparison values when materialization did not land", () => {
        __test.writeRow(dbPath, {
            ...baseRow("unmaterialized-fold", 1),
            materialized: false,
        });

        expect(
            db
                .prepare(
                    `SELECT system_hash_prev, system_hash_new,
                            m0_model_key_prev, m0_model_key_new
                     FROM transform_decisions WHERE message_id = 'unmaterialized-fold'`,
                )
                .get(),
        ).toEqual({
            system_hash_prev: null,
            system_hash_new: null,
            m0_model_key_prev: null,
            m0_model_key_new: null,
        });
    });

    it("records observed tool-set operands even when the pass did not materialize m[0]", () => {
        __test.writeRow(dbPath, {
            ...baseRow("tool-set-observation", 1),
            materialized: false,
            materializeReason: null,
            m0ToolSetHashPrev: "tools-before",
            m0ToolSetHashNew: "tools-after",
        });

        expect(
            db
                .prepare(
                    `SELECT materialized, m0_tool_set_hash_prev, m0_tool_set_hash_new
                     FROM transform_decisions WHERE message_id = 'tool-set-observation'`,
                )
                .get(),
        ).toEqual({
            materialized: 0,
            m0_tool_set_hash_prev: "tools-before",
            m0_tool_set_hash_new: "tools-after",
        });
    });

    it("does not prune below the cap", () => {
        for (let i = 0; i < TEST_CAP - 1; i++) {
            __test.writeRow(dbPath, baseRow(`m-${i}`, 1000 + i));
        }
        expect(rowCount()).toBe(TEST_CAP - 1);
    });

    it("keeps the production retention constant sane", () => {
        // Guard against accidental drift of the real cap.
        expect(TRANSFORM_DECISIONS_RETENTION).toBe(2000);
    });
});

describe("findNewestPiAssistantEntryIdAfter (index-aware binding)", () => {
    const asst = (id: string) => ({
        id,
        type: "message",
        message: { role: "assistant" },
    });
    const user = (id: string) => ({
        id,
        type: "message",
        message: { role: "user" },
    });

    it("binds to the first assistant AFTER the snapshot", () => {
        const entries = [asst("a1"), user("u1"), asst("a2")];
        expect(__test.findNewestPiAssistantEntryIdAfter(entries, "a1")).toBe("a2");
    });

    it("returns null when no assistant exists after the snapshot (no older-entry fallback)", () => {
        // Branch still ends at the snapshot — a value-skip scan would wrongly
        // return the older a1; the index-aware version must refuse.
        const entries = [asst("a1"), asst("a2")];
        expect(__test.findNewestPiAssistantEntryIdAfter(entries, "a2")).toBeNull();
    });

    it("refuses to bind when the snapshot id is absent (compacted/reordered)", () => {
        const entries = [asst("a1"), asst("a2")];
        expect(__test.findNewestPiAssistantEntryIdAfter(entries, "missing-snapshot")).toBeNull();
    });

    it("with a null snapshot, binds to the FIRST assistant (recorded when none existed)", () => {
        // Null snapshot = no assistant at record time, so the first assistant to
        // arrive is the one this decision belongs to (not the newest — that would
        // misattribute to a later pass's message if resolve lagged).
        const entries = [asst("a1"), user("u1"), asst("a2"), user("u2")];
        expect(__test.findNewestPiAssistantEntryIdAfter(entries, null)).toBe("a1");
    });
});
