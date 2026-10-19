/// <reference types="bun-types" />

import { expect, test } from "bun:test";
import { join } from "node:path";
import { projectOpencodeReasoningBudgetCutoff } from "../../hooks/magic-context/reasoning-budget";
import type { MessageLike } from "../../hooks/magic-context/tag-messages";
import { prewarmTagOwners } from "../../hooks/magic-context/tag-owner-warmup";
import { Database } from "../../shared/sqlite";
import { createTestTempDir } from "../../shared/test-temp-dir";
import { initializeDatabase } from "./storage-db";
import {
    getMaxTagNumberByOwnerMessage,
    getReasoningTokenEstimatesByMessage,
    insertTag,
} from "./storage-tags";

const SESSION = "ses-stall-cache-review";
const messages: MessageLike[] = ["old", "new"].map(
    (id) =>
        ({
            info: { id, role: "assistant", tokens: { reasoning: 100 } },
            parts: [{ type: "reasoning", text: "visible thought" }],
        }) as unknown as MessageLike,
);

async function seed(db: Database): Promise<void> {
    initializeDatabase(db);
    for (const [id, tag] of [
        ["old", 5],
        ["new", 10],
    ] as const) {
        insertTag(db, SESSION, id, "message", 10, tag, 10, null, 0, null, null, {
            tokenCount: 5,
            inputTokenCount: 0,
            reasoningTokenCount: 100,
        });
    }
    expect(await prewarmTagOwners(db, SESSION, 1)).toBe(true);
    expect(projectOpencodeReasoningBudgetCutoff(db, SESSION, messages, 100, 0, 1)).toBe(5);
    expect(getReasoningTokenEstimatesByMessage(db, SESSION, 1).get("old")).toBe(100);
}

async function expectCommittedProjection(db: Database): Promise<void> {
    expect(await prewarmTagOwners(db, SESSION, 1)).toBe(true);
    const row = db
        .prepare(
            "SELECT tag_number, reasoning_token_count FROM tags WHERE session_id = ? AND message_id = 'old'",
        )
        .get(SESSION) as { tag_number: number; reasoning_token_count: number };
    expect(row).toEqual({ tag_number: 6, reasoning_token_count: 1000 });
    expect(projectOpencodeReasoningBudgetCutoff(db, SESSION, messages, 100, 0, 1)).toBe(6);
    expect(getReasoningTokenEstimatesByMessage(db, SESSION, 1).get("old")).toBe(1000);
}

const UPDATE_RETURNING =
    "UPDATE tags SET tag_number = 6, reasoning_token_count = 1000 WHERE session_id = ? AND message_id = 'old' RETURNING tag_number";

test("iterate write: consuming UPDATE RETURNING must refresh the reasoning cutoff", async () => {
    const db = new Database(":memory:");
    try {
        await seed(db);
        expect([...db.prepare(UPDATE_RETURNING).iterate(SESSION)]).toEqual([{ tag_number: 6 }]);
        await expectCommittedProjection(db);
    } finally {
        db.close();
    }
});
test("iterate write: executing the same UPDATE RETURNING with all refreshes the cutoff", async () => {
    const db = new Database(":memory:");
    try {
        await seed(db);
        expect(db.prepare(UPDATE_RETURNING).all(SESSION)).toEqual([{ tag_number: 6 }]);
        await expectCommittedProjection(db);
    } finally {
        db.close();
    }
});

test("mixed tuple write: status plus identity assignments must refresh the reasoning cutoff", async () => {
    const db = new Database(":memory:");
    try {
        await seed(db);
        db.prepare(
            "UPDATE tags SET status = 'dropped', (tag_number, reasoning_token_count) = (6, 1000) WHERE session_id = ? AND message_id = 'old'",
        ).run(SESSION);
        await expectCommittedProjection(db);
    } finally {
        db.close();
    }
});
test("mixed tuple write: scalar identity assignments refresh the reasoning cutoff", async () => {
    const db = new Database(":memory:");
    try {
        await seed(db);
        db.prepare(
            "UPDATE tags SET status = 'dropped', tag_number = 6, reasoning_token_count = 1000 WHERE session_id = ? AND message_id = 'old'",
        ).run(SESSION);
        await expectCommittedProjection(db);
    } finally {
        db.close();
    }
});

/**
 * A process that is not running Magic Context (here a plain bun:sqlite
 * connection) rewrites a tag's number and reasoning count in place, which
 * leaves the session's tag count and highest id as they were. Magic Context
 * connections bump the session's tag identity revision on such a write (see
 * storage-tag-identity-revision.ts); this one does not, so the summary keeps its
 * cached owners. Re-reading the session on every foreign commit instead would
 * cost a whole-session read on nearly every pass of a busy host. The update
 * changes no row count and no id, so the count and highest id still fit "only
 * appends". The test records the gap and the two things that close it: a new
 * connection, or an identity write by this process.
 */
test("external process writes (residual): an in-place re-key keeping count and highest id is seen only after invalidation", async () => {
    const { dir, cleanup } = createTestTempDir("mc-stall-cache-review-");
    const path = join(dir, "context.db");
    const db = new Database(path);
    let fresh: Database | undefined;
    try {
        await seed(db);
        // A raw connection in a child process cannot bump the parent's generation.
        const child = Bun.spawn(
            [
                process.execPath,
                "-e",
                `
            import { Database } from 'bun:sqlite';
            const db = new Database(process.argv[1]);
            db.prepare(${JSON.stringify(UPDATE_RETURNING)}).all(${JSON.stringify(SESSION)});
            db.close();
        `,
                path,
            ],
            { stdout: "pipe", stderr: "pipe", windowsHide: true },
        );
        const [code, errors] = await Promise.all([child.exited, new Response(child.stderr).text()]);
        expect({ code, errors }).toEqual({ code: 0, errors: "" });
        expect(await prewarmTagOwners(db, SESSION, 1)).toBe(true);
        // The warm summary still answers from the old owners.
        expect(projectOpencodeReasoningBudgetCutoff(db, SESSION, messages, 100, 0, 1)).toBe(5);
        expect(getReasoningTokenEstimatesByMessage(db, SESSION, 1).get("old")).toBe(100);
        // A new connection reads the committed rows.
        fresh = new Database(path);
        await expectCommittedProjection(fresh);
        // So does this one after any identity write of its own.
        db.prepare(
            "UPDATE tags SET message_id = message_id WHERE session_id = ? AND tag_number = 10",
        ).run(SESSION);
        await expectCommittedProjection(db);
    } finally {
        fresh?.close();
        db.close();
        cleanup();
    }
});

test("external process writes: a tool tag given an owner by another process (the tool-owner backfill) is seen", async () => {
    const { dir, cleanup } = createTestTempDir("mc-stall-cache-review-");
    const path = join(dir, "context.db");
    const db = new Database(path);
    try {
        await seed(db);
        // A tool tag written before owners were recorded.
        insertTag(db, SESSION, "call-legacy", "tool", 10, 12, 0, "read", 0, null);
        expect(getMaxTagNumberByOwnerMessage(db, SESSION).get("old")).toBe(5);
        const child = Bun.spawn(
            [
                process.execPath,
                "-e",
                `
            import { Database } from 'bun:sqlite';
            const db = new Database(process.argv[1]);
            db.prepare("UPDATE tags SET tool_owner_message_id = 'old' WHERE session_id = ? AND tag_number = 12 AND tool_owner_message_id IS NULL").run(${JSON.stringify(SESSION)});
            db.close();
        `,
                path,
            ],
            { stdout: "pipe", stderr: "pipe", windowsHide: true },
        );
        const [code, errors] = await Promise.all([child.exited, new Response(child.stderr).text()]);
        expect({ code, errors }).toEqual({ code: 0, errors: "" });
        expect(await prewarmTagOwners(db, SESSION, 1)).toBe(true);
        expect(getMaxTagNumberByOwnerMessage(db, SESSION).get("old")).toBe(12);
    } finally {
        db.close();
        cleanup();
    }
});
