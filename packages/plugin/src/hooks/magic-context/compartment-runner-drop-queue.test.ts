/// <reference types="bun-types" />
import { createTestTempDirFromPath } from "../../shared/test-temp-dir";

/**
 * v3.3.1 Layer C — plan §5 / Finding D: drop-queue composite-identity
 * tests.
 *
 * The bug class this guards: pre-fix `queueDropsForCompartmentalizedMessages`
 * matched tool tags by bare `messageId === callId`. A callId reused
 * outside the compartment range matched a tag inside the compartment
 * by string equality alone, queuing drops on tags that should have
 * stayed live. Layer C filters by `(callId, tool_owner_message_id)`.
 */

import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { protectedToolTagNumbers } from "../../features/magic-context/reclaim-protection";
import {
    closeDatabase,
    getPendingOps,
    insertTag,
    openDatabase,
    updateTagStatus,
} from "../../features/magic-context/storage";
import { queuePendingOp } from "../../features/magic-context/storage-ops";
import { getActiveTagsBySession } from "../../features/magic-context/storage-tags";
import { applyPendingOperations } from "./apply-operations";
import {
    prepareCompartmentDrops,
    queueDropsForCompartmentalizedMessages,
    queuePreparedCompartmentDrops,
} from "./compartment-runner-drop-queue";
import { withRawMessageProvider } from "./read-session-chunk";
import type { RawMessage } from "./read-session-raw";

const tempDirs: string[] = [];
const originalXdgDataHome = process.env.XDG_DATA_HOME;

beforeEach(() => {
    closeDatabase();
});

afterEach(() => {
    closeDatabase();
    if (originalXdgDataHome === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = originalXdgDataHome;
    for (const dir of tempDirs) {
        try {
            rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
        } catch {
            // Ignore EBUSY on Windows
        }
    }
    tempDirs.length = 0;
});

function useTempDataHome(prefix: string): void {
    const dir = createTestTempDirFromPath(join(tmpdir(), prefix));
    tempDirs.push(dir);
    process.env.XDG_DATA_HOME = dir;
}

function makeRawMessages(messages: RawMessage[]) {
    return {
        readMessages: () => messages,
    };
}

describe("queueDropsForCompartmentalizedMessages composite identity", () => {
    it("review regression: repeated historian publication of a held result must have bounded pending depth", () => {
        useTempDataHome("drop-queue-held-bound-");
        const db = openDatabase();
        insertTag(db, "ses-1", "held-call", "tool", 100, 1, 0, "todowrite", 0, "held-owner");
        const observed = {
            messageFileKeys: new Set<string>(),
            toolObservations: new Map([["held-call", new Set(["held-owner"])]]),
        };
        queueDropsForCompartmentalizedMessages(db, "ses-1", 1, observed);
        const first = getPendingOps(db, "ses-1");
        for (let n = 0; n < 99; n++)
            queueDropsForCompartmentalizedMessages(db, "ses-1", 1, observed);
        expect(getPendingOps(db, "ses-1")).toHaveLength(1);
        expect(getPendingOps(db, "ses-1")).toEqual(first);
        const active = getActiveTagsBySession(db, "ses-1");
        expect(
            applyPendingOperations(
                "ses-1",
                db,
                new Map(),
                protectedToolTagNumbers(active, { todowrite: 1 }),
            ),
        ).toBe(false);
        expect(getActiveTagsBySession(db, "ses-1")).toEqual(active);
        expect(getPendingOps(db, "ses-1")).toEqual(first);
    });

    it("prepared drops are byte-identical to the previous queue with a frozen clock", () => {
        useTempDataHome("drop-queue-byte-parity-");
        const db = openDatabase();
        insertTag(db, "ses-1", "m1:p0", "message", 10, 5);
        insertTag(db, "ses-1", "m1:file1", "file", 10, 3);
        insertTag(db, "ses-1", "call", "tool", 10, 1, 0, "read", 0, "inside");
        insertTag(db, "ses-1", "call", "tool", 10, 2, 0, "read", 0, "outside");
        insertTag(db, "ses-1", "legacy", "tool", 10, 4);
        insertTag(db, "ses-1", "m1:p1", "message", 10, 6);
        updateTagStatus(db, "ses-1", 6, "dropped");
        insertTag(db, "ses-1", "tail:p0", "message", 10, 7);
        // Preserve an existing row's identity when publication selects it again.
        queuePendingOp(db, "ses-1", 3, "drop", 900);
        const keys = {
            messageFileKeys: new Set(["m1:p0", "m1:file1", "m1:p1"]),
            toolObservations: new Map([
                ["call", new Set(["inside"])],
                ["legacy", new Set(["inside"])],
            ]),
        };
        const clock = spyOn(Date, "now").mockReturnValue(1234);
        const queueBytes = () =>
            JSON.stringify(db.prepare("SELECT * FROM pending_ops ORDER BY id").all());
        try {
            // Frozen reference implementation of the preselection-free queue.
            db.exec("BEGIN IMMEDIATE");
            for (const tag of getActiveTagsBySession(db, "ses-1")) {
                const owners = keys.toolObservations.get(tag.messageId);
                const matches =
                    tag.type === "tool"
                        ? owners !== undefined &&
                          (tag.toolOwnerMessageId === null || owners.has(tag.toolOwnerMessageId))
                        : keys.messageFileKeys.has(tag.messageId);
                if (matches) queuePendingOp(db, "ses-1", tag.tagNumber, "drop");
            }
            const previousBytes = queueBytes();
            expect(getPendingOps(db, "ses-1").map((op) => op.tagId)).toEqual([3, 1, 4, 5]);
            db.exec("ROLLBACK");
            const prepared = prepareCompartmentDrops(db, "ses-1", 2, keys);
            db.exec("BEGIN IMMEDIATE");
            queuePreparedCompartmentDrops(db, prepared);
            expect(queueBytes()).toBe(previousBytes);
            db.exec("ROLLBACK");
            expect(getPendingOps(db, "ses-1").map((op) => op.tagId)).toEqual([3]);
        } finally {
            if (db.inTransaction) db.exec("ROLLBACK");
            clock.mockRestore();
        }
    });

    it("revalidates candidate status and source identity after concurrent changes", () => {
        useTempDataHome("drop-queue-revalidation-");
        const db = openDatabase();
        for (let number = 1; number <= 8; number++) {
            insertTag(db, "ses-1", `m${number}:p0`, "message", 10, number);
        }
        insertTag(db, "ses-1", "call", "tool", 10, 9, 0, "read", 0, null);
        const keys = {
            messageFileKeys: new Set(Array.from({ length: 8 }, (_, i) => `m${i + 1}:p0`)),
            toolObservations: new Map([["call", new Set(["inside"])]]),
        };
        const prepared = prepareCompartmentDrops(db, "ses-1", 9, keys);
        expect(prepared.candidates).toHaveLength(9);
        // These commits stand in for a foreground transform while the publisher
        // waits to acquire the writer. No stale candidate may target a new source.
        updateTagStatus(db, "ses-1", 1, "dropped");
        updateTagStatus(db, "ses-1", 2, "compacted");
        db.prepare("DELETE FROM tags WHERE session_id = ? AND tag_number = 3").run("ses-1");
        insertTag(db, "ses-1", "m3:p0", "message", 10, 3);
        db.prepare(
            "UPDATE tags SET message_id = 'tail:p0' WHERE session_id = ? AND tag_number = 4",
        ).run("ses-1");
        db.prepare("UPDATE tags SET type = 'file' WHERE session_id = ? AND tag_number = 5").run(
            "ses-1",
        );
        db.prepare("UPDATE tags SET tag_number = 60 WHERE session_id = ? AND tag_number = 6").run(
            "ses-1",
        );
        db.prepare(
            "UPDATE tags SET session_id = 'ses-other' WHERE session_id = ? AND tag_number = 7",
        ).run("ses-1");
        db.prepare(
            "UPDATE tags SET tool_owner_message_id = 'outside' WHERE session_id = ? AND tag_number = 9",
        ).run("ses-1");
        // A size-only update leaves the source identity intact.
        db.prepare("UPDATE tags SET byte_size = 99 WHERE session_id = ? AND tag_number = 8").run(
            "ses-1",
        );
        db.exec("BEGIN IMMEDIATE");
        try {
            queuePreparedCompartmentDrops(db, prepared);
            expect(getPendingOps(db, "ses-1").map((op) => op.tagId)).toEqual([8]);
            db.exec("COMMIT");
        } finally {
            if (db.inTransaction) db.exec("ROLLBACK");
        }
    });

    it("does NOT queue a drop for a callId reused outside the compartment", async () => {
        //#given — `read:32` is invoked twice: at message 5 (in
        // compartment), again at message 10 (outside compartment).
        // Both have distinct owner ids. Pre-fix this would queue both
        // tags for drop. Post-fix only tag-100 (owner m-asst-5) gets
        // queued.
        useTempDataHome("drop-queue-collision-");
        const db = openDatabase();

        const messages: RawMessage[] = [
            { id: "m-user-1", role: "user", ordinal: 1, parts: [] },
            {
                id: "m-asst-5",
                role: "assistant",
                time_created: 5,
                ordinal: 5,
                parts: [{ type: "tool-invocation", callID: "read:32" }],
            },
            {
                id: "m-tool-6",
                role: "tool",
                time_created: 6,
                ordinal: 6,
                parts: [{ type: "tool", callID: "read:32", state: { output: "first" } }],
            },
            {
                id: "m-user-7",
                role: "user",
                time_created: 7,
                ordinal: 7,
                parts: [{ type: "text", text: "ask again" }],
            },
            {
                id: "m-asst-10",
                role: "assistant",
                time_created: 10,
                ordinal: 10,
                parts: [{ type: "tool-invocation", callID: "read:32" }],
            },
            {
                id: "m-tool-11",
                role: "tool",
                time_created: 11,
                ordinal: 11,
                parts: [{ type: "tool", callID: "read:32", state: { output: "second" } }],
            },
        ];

        // Two persisted tags for the same callId, different owners.
        insertTag(db, "ses-1", "read:32", "tool", 100, 100, 0, "read", 50, "m-asst-5");
        insertTag(db, "ses-1", "read:32", "tool", 200, 250, 0, "read", 50, "m-asst-10");

        //#when — compartment covers messages 1-7 (so m-asst-5 is in,
        // m-asst-10 is out).
        await withRawMessageProvider("ses-1", makeRawMessages(messages), () =>
            queueDropsForCompartmentalizedMessages(db, "ses-1", 7),
        );

        //#then — only tag 100 (in-compartment) is queued.
        const ops = getPendingOps(db, "ses-1");
        expect(ops).toHaveLength(1);
        expect(ops[0]?.tagId).toBe(100);
    });

    it("queues both tags when both owners are inside the compartment", async () => {
        //#given — same callId across two assistant turns, both inside
        // the compartment range.
        useTempDataHome("drop-queue-both-in-");
        const db = openDatabase();

        const messages: RawMessage[] = [
            {
                id: "m-asst-3",
                role: "assistant",
                time_created: 3,
                ordinal: 3,
                parts: [{ type: "tool-invocation", callID: "grep:1" }],
            },
            {
                id: "m-tool-4",
                role: "tool",
                time_created: 4,
                ordinal: 4,
                parts: [{ type: "tool", callID: "grep:1", state: { output: "result-1" } }],
            },
            {
                id: "m-asst-5",
                role: "assistant",
                time_created: 5,
                ordinal: 5,
                parts: [{ type: "tool-invocation", callID: "grep:1" }],
            },
            {
                id: "m-tool-6",
                role: "tool",
                time_created: 6,
                ordinal: 6,
                parts: [{ type: "tool", callID: "grep:1", state: { output: "result-2" } }],
            },
        ];

        insertTag(db, "ses-1", "grep:1", "tool", 100, 50, 0, "grep", 20, "m-asst-3");
        insertTag(db, "ses-1", "grep:1", "tool", 200, 60, 0, "grep", 20, "m-asst-5");

        //#when
        await withRawMessageProvider("ses-1", makeRawMessages(messages), () =>
            queueDropsForCompartmentalizedMessages(db, "ses-1", 6),
        );

        //#then
        const ops = getPendingOps(db, "ses-1");
        const queuedTagIds = ops.map((op) => op.tagId).sort();
        expect(queuedTagIds).toEqual([50, 60]);
    });

    it("legacy NULL-owner row falls back to bare-callId match", async () => {
        //#given — a NULL-owner tool tag (pre-Layer-B-backfill data).
        // The drop queue must still fire for this tag; lazy adoption
        // will populate the owner on the next tag-messages pass.
        useTempDataHome("drop-queue-null-owner-");
        const db = openDatabase();

        const messages: RawMessage[] = [
            {
                id: "m-asst",
                role: "assistant",
                time_created: 1,
                ordinal: 1,
                parts: [{ type: "tool-invocation", callID: "legacy:1" }],
            },
            {
                id: "m-tool",
                role: "tool",
                time_created: 2,
                ordinal: 2,
                parts: [{ type: "tool", callID: "legacy:1", state: { output: "ok" } }],
            },
        ];

        // NULL owner (pre-v10 row).
        insertTag(db, "ses-1", "legacy:1", "tool", 100, 7, 0, null, 0, null);

        //#when
        await withRawMessageProvider("ses-1", makeRawMessages(messages), () =>
            queueDropsForCompartmentalizedMessages(db, "ses-1", 2),
        );

        //#then
        const ops = getPendingOps(db, "ses-1");
        expect(ops).toHaveLength(1);
        expect(ops[0]?.tagId).toBe(7);
    });

    it("skips already-dropped tags", async () => {
        //#given
        useTempDataHome("drop-queue-already-dropped-");
        const db = openDatabase();

        const messages: RawMessage[] = [
            {
                id: "m-asst",
                role: "assistant",
                time_created: 1,
                ordinal: 1,
                parts: [{ type: "tool-invocation", callID: "x:1" }],
            },
            {
                id: "m-tool",
                role: "tool",
                time_created: 2,
                ordinal: 2,
                parts: [{ type: "tool", callID: "x:1", state: { output: "ok" } }],
            },
        ];

        insertTag(db, "ses-1", "x:1", "tool", 100, 1, 0, "x", 0, "m-asst");
        updateTagStatus(db, "ses-1", 1, "dropped");

        //#when
        await withRawMessageProvider("ses-1", makeRawMessages(messages), () =>
            queueDropsForCompartmentalizedMessages(db, "ses-1", 2),
        );

        //#then — no drops queued.
        expect(getPendingOps(db, "ses-1")).toHaveLength(0);
    });
});
