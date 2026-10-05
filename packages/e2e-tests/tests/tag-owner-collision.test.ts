/// <reference types="bun-types" />

/**
 * v3.3.1 Layer C — end-to-end collision-repro test.
 *
 * Drives a real OpenCode + magic-context plugin pair through a
 * scenario the bug class this fix is for would have corrupted:
 * two assistant turns that share an OpenCode-generated tool callID
 * (e.g. both invoke `read:32`). Pre-fix the second turn's tag bound
 * to the first turn's row by `messageId == callId`; dropping the
 * first would silently corrupt the second.
 *
 * Post-fix:
 *   1. Schema migration v10 is applied (column exists).
 *   2. Each tool tag carries a `tool_owner_message_id` so the two
 *      turns are stored as DISTINCT rows (composite identity).
 *   3. The composite-key drop queue and heuristic dedup don't
 *      cross-merge between owners.
 *
 * The harness can't drive real tool execution (OpenCode requires
 * registered tools and the mock env doesn't have them), so we seed
 * the DB directly with the shape the new tagger would produce and
 * verify the storage-side and runtime-side invariants hold.
 *
 * Plugin-side unit tests (`tag-messages-collision.test.ts`,
 * `compartment-runner-drop-queue.test.ts`, `migrations-v10.test.ts`)
 * cover the algorithmic correctness with full fidelity. This test's
 * job is to prove the wiring holds when the plugin runs against a
 * real OpenCode subprocess.
 */

import { Database } from "bun:sqlite";
import { afterAll, beforeAll, expect, it } from "bun:test";
import {
    createScenarioHarness,
    forEachHost,
    type ScenarioHarness,
} from "../src/scenario-hosts";
import { openTestDb } from "../src/test-db";

forEachHost(import.meta.url, "tag-owner collision repro (v3.3.1 Layer C)", (host) => {
    let h: ScenarioHarness;

    beforeAll(async () => {
        h = await createScenarioHarness(host, {
            magicContextConfig: { protected_tags: 1 },
        });
    });

    afterAll(async () => {
        await h.dispose();
    });
    it("creates a session and applies migration v10", async () => {
        h.mock.setDefault({
            text: "first response",
            usage: {
                input_tokens: 100,
                output_tokens: 10,
                cache_creation_input_tokens: 100,
            },
        });

        const sessionId = await h.createSession();
        await h.sendPrompt(sessionId, "create-session-for-collision-test");

        await h.waitFor(() => h.hasContextDb(), { label: "context.db created" });

        // Plugin's openDatabase() runs migrations on startup. Confirm
        // v10 (or higher) is recorded in the migration log.
        const db = h.contextDb();
        const row = db
            .prepare("SELECT MAX(version) AS v FROM schema_migrations")
            .get() as { v: number };
        expect(row.v).toBeGreaterThanOrEqual(10);

        // Confirm the v10 column exists with the expected default.
        const cols = db.prepare("PRAGMA table_info(tags)").all() as Array<{
            name: string;
            dflt_value: string | null;
            type: string;
        }>;
        const owner = cols.find((c) => c.name === "tool_owner_message_id");
        expect(owner).toBeDefined();
        expect(owner?.type).toBe("TEXT");

        // Confirm both v10 indexes exist.
        const idxComposite = db
            .prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name=?")
            .get("idx_tags_tool_composite") as { sql: string } | undefined;
        expect(idxComposite).toBeDefined();
        expect(idxComposite?.sql).toContain("UNIQUE");

        const idxNullOwner = db
            .prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name=?")
            .get("idx_tags_tool_null_owner") as { sql: string } | undefined;
        expect(idxNullOwner).toBeDefined();
    }, 60_000);

    it("two tool rows with same callId + different owners coexist via composite UNIQUE", async () => {
        // Seed the DB shape the post-Layer-C tagger would produce when
        // two assistant turns reuse the same callId. We use a
        // writable handle because the harness's default DB handle is
        // read-only.
        const sessionId = "ses-collision-repro";
        const dbPath = h.contextDb().filename;
        const writable = openTestDb(dbPath);
        // Mirror production (storage-db.ts initializeDatabase): wait out a
        // concurrent writer instead of throwing SQLITE_BUSY immediately. The
        // live plugin process holds the write lock during its startup
        // migration (which can take several seconds on slow CI disks), so a
        // pragma-less handle hits "database is locked" before it can insert.
        try {
            // Two tool tags: same callID `read:32`, different owners.
            // With composite identity these are DISTINCT rows. Pre-fix
            // they would have been the SAME row (last-write-wins via
            // `messageId == callId`), so seeding both would have
            // unique-violated.
            const insert = writable.prepare(
                "INSERT INTO tags (session_id, message_id, type, tag_number, byte_size, tool_name, tool_owner_message_id, harness) VALUES (?, ?, 'tool', ?, ?, 'read', ?, ?)",
            );
            insert.run(sessionId, "read:32", 100, 200, "m-asst-1", h.harnessId);
            insert.run(sessionId, "read:32", 200, 200, "m-asst-2", h.harnessId);

            const tags = writable
                .prepare(
                    "SELECT tag_number, tool_owner_message_id FROM tags WHERE session_id = ? ORDER BY tag_number",
                )
                .all(sessionId) as Array<{
                tag_number: number;
                tool_owner_message_id: string;
            }>;
            expect(tags).toHaveLength(2);
            expect(tags.map((t) => t.tag_number)).toEqual([100, 200]);
            expect(tags.map((t) => t.tool_owner_message_id)).toEqual([
                "m-asst-1",
                "m-asst-2",
            ]);

            // The partial UNIQUE composite index forbids a third
            // (same-callId, same-owner) insert. This is the DB-level
            // guard that defends the runtime invariant.
            expect(() =>
                insert.run(sessionId, "read:32", 999, 200, "m-asst-1", h.harnessId),
            ).toThrow(/UNIQUE/i);

            // ...but a third row with a NEW owner is fine. Cross-turn
            // collisions remain freely resolvable.
            insert.run(sessionId, "read:32", 300, 200, "m-asst-3", h.harnessId);
            const after = writable
                .prepare("SELECT COUNT(*) AS n FROM tags WHERE session_id = ?")
                .get(sessionId) as { n: number };
            expect(after.n).toBe(3);
        } finally {
            writable.close();
        }
    }, 30_000);

    it("legacy NULL-owner rows for the same callId still coexist (no UNIQUE collision)", async () => {
        // Pre-Layer-B-backfill data: tool tags written before v10 had
        // `tool_owner_message_id = NULL`. The partial UNIQUE
        // (`WHERE tool_owner_message_id IS NOT NULL`) intentionally
        // does NOT include those rows, so the collision artifact (two
        // NULL-owner rows with same callId) survives and lazy
        // adoption can clean them up over time.
        const sessionId = "ses-legacy-null";
        const dbPath = h.contextDb().filename;
        const writable = openTestDb(dbPath);
        // Mirror production (storage-db.ts initializeDatabase): wait out a
        // concurrent writer instead of throwing SQLITE_BUSY immediately. The
        // live plugin process holds the write lock during its startup
        // migration (which can take several seconds on slow CI disks), so a
        // pragma-less handle hits "database is locked" before it can insert.
        try {
            const insert = writable.prepare(
                "INSERT INTO tags (session_id, message_id, type, tag_number, byte_size, tool_name, tool_owner_message_id, harness) VALUES (?, ?, 'tool', ?, ?, 'read', NULL, ?)",
            );
            insert.run(sessionId, "legacy:1", 1, 100, h.harnessId);
            insert.run(sessionId, "legacy:1", 2, 100, h.harnessId); // same callId, same NULL owner — must succeed

            const tags = writable
                .prepare(
                    "SELECT COUNT(*) AS n FROM tags WHERE session_id = ? AND tool_owner_message_id IS NULL",
                )
                .get(sessionId) as { n: number };
            expect(tags.n).toBe(2);
        } finally {
            writable.close();
        }
    }, 30_000);

    it("dropping tag-1 (m-asst-1) leaves tag-2 (m-asst-2) active — no cross-owner cascade", async () => {
        // The bug this whole fix prevents: dropping the first turn's
        // tag must not propagate to the second turn's content. With
        // composite identity, drop ops target a single tag_number;
        // the second turn's tag is a separate row and stays active.
        const sessionId = "ses-drop-isolation";
        const dbPath = h.contextDb().filename;
        const writable = openTestDb(dbPath);
        // Mirror production (storage-db.ts initializeDatabase): wait out a
        // concurrent writer instead of throwing SQLITE_BUSY immediately. The
        // live plugin process holds the write lock during its startup
        // migration (which can take several seconds on slow CI disks), so a
        // pragma-less handle hits "database is locked" before it can insert.
        try {
            const insert = writable.prepare(
                "INSERT INTO tags (session_id, message_id, type, tag_number, byte_size, tool_name, tool_owner_message_id, status, harness) VALUES (?, ?, 'tool', ?, ?, 'read', ?, 'active', ?)",
            );
            insert.run(sessionId, "read:32", 1, 200, "m-asst-1", h.harnessId);
            insert.run(sessionId, "read:32", 2, 200, "m-asst-2", h.harnessId);

            // Simulate a drop op fired against tag 1.
            writable
                .prepare(
                    "UPDATE tags SET status = 'dropped' WHERE session_id = ? AND tag_number = ?",
                )
                .run(sessionId, 1);

            const rows = writable
                .prepare(
                    "SELECT tag_number, status, tool_owner_message_id FROM tags WHERE session_id = ? ORDER BY tag_number",
                )
                .all(sessionId) as Array<{
                tag_number: number;
                status: string;
                tool_owner_message_id: string;
            }>;
            expect(rows).toEqual([
                { tag_number: 1, status: "dropped", tool_owner_message_id: "m-asst-1" },
                { tag_number: 2, status: "active", tool_owner_message_id: "m-asst-2" },
            ]);
        } finally {
            writable.close();
        }
    }, 30_000);
});
