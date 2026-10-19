/// <reference types="bun-types" />

import { Database as ForeignDatabase } from "bun:sqlite";
import { expect, test } from "bun:test";
import { join } from "node:path";
import { prewarmTagOwners } from "../../hooks/magic-context/tag-owner-warmup";
import { Database } from "../../shared/sqlite";
import { createTestTempDir } from "../../shared/test-temp-dir";
import { initializeDatabase } from "./storage-db";
import { installTagIdentityRevisionTrigger } from "./storage-tag-identity-revision";
import { getMaxTagNumberByOwnerMessage, getReasoningTokenEstimatesByMessage } from "./storage-tags";

const SESSION = "ses-stall-r2-tags";

interface Connection {
    prepare(sql: string): { run(...bindings: Array<string | number>): unknown };
    transaction(fn: () => void): () => void;
}

async function withStore(
    run: (reader: Database, foreign: ForeignDatabase, path: string) => Promise<void>,
): Promise<void> {
    const { dir, cleanup } = createTestTempDir("mc-stall-r2-tags-");
    const path = join(dir, "fixture.db");
    const reader = new Database(path);
    initializeDatabase(reader);
    reader.exec("PRAGMA journal_mode = WAL");
    reader
        .prepare(
            "INSERT INTO tags (session_id, message_id, type, byte_size, tag_number, reasoning_token_count) VALUES (?, 'old', 'message', 10, 1, 40)",
        )
        .run(SESSION);
    reader
        .prepare(
            "INSERT INTO tags (session_id, message_id, type, byte_size, tag_number, reasoning_token_count) VALUES (?, 'tail', 'message', 10, 2, 100)",
        )
        .run(SESSION);
    expect(await prewarmTagOwners(reader, SESSION, 1)).toBe(true);
    expect(getReasoningTokenEstimatesByMessage(reader, SESSION, 1).get("old")).toBe(40);
    expect(getMaxTagNumberByOwnerMessage(reader, SESSION).get("old")).toBe(1);
    const foreign = new ForeignDatabase(path);
    try {
        await run(reader, foreign, path);
    } finally {
        foreign.close();
        reader.close();
        cleanup();
    }
}

/**
 * Who writes the backfill. `local`: the reader's own connection, whose writes
 * this process counts itself (getTagIdentityWriteGeneration). `foreign`: a
 * plain connection given the identity-revision trigger that initializeDatabase
 * installs on every Magic Context connection, so it acts like another Magic
 * Context process. `raw`: a plain connection without that trigger, like a
 * tool editing the file directly.
 */
async function backfillAndAppend(writerKind: "local" | "foreign" | "raw"): Promise<void> {
    await withStore(async (reader, foreign) => {
        if (writerKind === "foreign")
            installTagIdentityRevisionTrigger(foreign as unknown as Database);
        const writer: Connection = writerKind === "local" ? reader : foreign;
        // An append-shaped commit need not consist only of appends: it can also
        // backfill a previously served message's reasoning estimate.
        writer.transaction(() => {
            writer
                .prepare(
                    "UPDATE tags SET reasoning_token_count = 1000 WHERE session_id = ? AND message_id = 'old'",
                )
                .run(SESSION);
            writer
                .prepare(
                    "INSERT INTO tags (session_id, message_id, type, byte_size, tag_number) VALUES (?, 'appended', 'message', 10, 3)",
                )
                .run(SESSION);
        })();
        expect(await prewarmTagOwners(reader, SESSION, 1)).toBe(true);
        expect(getMaxTagNumberByOwnerMessage(reader, SESSION).get("appended")).toBe(3);
        const full = reader
            .prepare(
                "SELECT reasoning_token_count AS n FROM tags WHERE session_id = ? AND message_id = 'old'",
            )
            .get(SESSION) as { n: number };
        expect(full.n).toBe(1000);
        expect(getReasoningTokenEstimatesByMessage(reader, SESSION, 1).get("old")).toBe(
            writerKind === "raw" ? 40 : full.n,
        );
    });
}

test("a foreign append plus reasoning backfill must refresh existing estimates even when count and max both grow", () =>
    backfillAndAppend("foreign"));
test("append plus reasoning backfill: the same-process identity generation refreshes estimates", () =>
    backfillAndAppend("local"));
// Documented limitation: a raw connection does not bump the identity revision,
// so a warm summary keeps the old estimate when the backfill arrives in the
// same commit as an append.
test("limitation: a raw connection's append plus reasoning backfill is not seen by a warm summary", () =>
    backfillAndAppend("raw"));

async function replaceWithExplicitId(reopen: boolean): Promise<void> {
    await withStore(async (reader, foreign, path) => {
        const { id } = foreign
            .prepare("SELECT id FROM tags WHERE session_id = ? AND message_id = 'old'")
            .get(SESSION) as { id: number };
        foreign.transaction(() => {
            foreign.prepare("DELETE FROM tags WHERE id = ?").run(id);
            foreign
                .prepare(
                    "INSERT INTO tags (id, session_id, message_id, type, byte_size, tag_number, reasoning_token_count) VALUES (?, ?, 'replacement', 'message', 10, 7, 700)",
                )
                .run(id, SESSION);
        })();
        const connection = reopen ? new Database(path) : reader;
        try {
            expect(await prewarmTagOwners(connection, SESSION, 1)).toBe(true);
            expect(getMaxTagNumberByOwnerMessage(connection, SESSION).get("old")).toBeUndefined();
            expect(getMaxTagNumberByOwnerMessage(connection, SESSION).get("replacement")).toBe(7);
            expect(
                getReasoningTokenEstimatesByMessage(connection, SESSION, 1).get("replacement"),
            ).toBe(700);
        } finally {
            if (reopen) connection.close();
        }
    });
}

test.failing("foreign delete and explicit-id reinsertion below max must not retain a deleted owner", () =>
    replaceWithExplicitId(false));
test("explicit-id reinsertion: reopening restores the full-read owners and estimates", () =>
    replaceWithExplicitId(true));
