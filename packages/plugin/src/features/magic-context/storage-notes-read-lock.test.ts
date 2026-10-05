/// <reference types="bun-types" />

import { afterEach, describe, expect, it } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "../../shared/sqlite";
import { closeQuietly } from "../../shared/sqlite-helpers";
import { createTestTempDirFromPath } from "../../shared/test-temp-dir";
import { runMigrations } from "./migrations";
import { initializeDatabase } from "./storage-db";
import { addNote, getNoteByIdInScope, getNotes, getSessionNotes } from "./storage-notes";

const SESSION = "ses_notes";
const LOCK_WAIT_MS = 1_500;
const cleanups: Array<() => void> = [];

afterEach(() => {
    for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

/** Two connections to one file database, the second holding the write lock. */
function lockedPair(options: { parkFirstNote?: boolean } = {}): {
    reader: Database;
    writer: Database;
} {
    const dir = createTestTempDirFromPath(join(tmpdir(), "notes-read-lock-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const path = join(dir, "context.db");
    const reader = new Database(path);
    cleanups.push(() => closeQuietly(reader));
    initializeDatabase(reader);
    runMigrations(reader);
    addNote(reader, "session", { sessionId: SESSION, content: "remember this" });
    if (options.parkFirstNote) {
        reader
            .prepare(
                "UPDATE notes SET status = 'pending', surface_condition = 'orphan' WHERE id = 1",
            )
            .run();
    }
    const writer = new Database(path);
    cleanups.push(() => closeQuietly(writer));
    writer.exec("BEGIN IMMEDIATE");
    cleanups.push(() => {
        try {
            writer.exec("ROLLBACK");
        } catch {
            // Already closed.
        }
    });
    // A read that needed the write lock would wait this long and then fail.
    reader.exec(`PRAGMA busy_timeout=${LOCK_WAIT_MS}`);
    return { reader, writer };
}

describe("note reads", () => {
    it("read notes while another connection holds the write lock", () => {
        const { reader } = lockedPair();
        const startedAt = performance.now();

        expect(getSessionNotes(reader, SESSION).map((note) => note.content)).toEqual([
            "remember this",
        ]);
        expect(
            getNoteByIdInScope(reader, 1, { sessionId: SESSION, projectPath: "/project" })?.content,
        ).toBe("remember this");
        // A read that waited for the lock would alone take LOCK_WAIT_MS.
        expect(performance.now() - startedAt).toBeLessThan(LOCK_WAIT_MS);
    });

    it("read a parked note while another connection holds the write lock", () => {
        const { reader } = lockedPair({ parkFirstNote: true });

        const notes = getNotes(reader, { sessionId: SESSION });

        // The heal waits for the lock, gives up, and leaves the row for a later read.
        expect(notes.map((note) => [note.content, note.status])).toEqual([
            ["remember this", "pending"],
        ]);
    });

    it("still heal a session note an older build parked as pending", () => {
        const dir = createTestTempDirFromPath(join(tmpdir(), "notes-heal-"));
        cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
        const db = new Database(join(dir, "context.db"));
        cleanups.push(() => closeQuietly(db));
        initializeDatabase(db);
        runMigrations(db);
        const note = addNote(db, "session", { sessionId: SESSION, content: "parked" });
        db.prepare(
            "UPDATE notes SET status = 'pending', surface_condition = 'orphan' WHERE id = ?",
        ).run(note.id);

        const [healed] = getNotes(db, { sessionId: SESSION });

        expect(healed?.status).toBe("active");
        expect(healed?.surfaceCondition).toBeNull();
    });
});
