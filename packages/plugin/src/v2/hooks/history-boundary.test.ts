/// <reference types="bun-types" />

import { afterEach, expect, test } from "bun:test";
import {
    appendCompartments,
    getCompartments,
} from "../../features/magic-context/compartment-storage";
import { getOrCreateSessionMeta } from "../../features/magic-context/storage";
import { initializeDatabase } from "../../features/magic-context/storage-db";
import { Database } from "../../shared/sqlite";
import { closeQuietly } from "../../shared/sqlite-helpers";
import { checkHistoryBoundary } from "./context";

const SESSION = "ses-v2-boundary";
let db: Database | undefined;

afterEach(() => {
    if (db) closeQuietly(db);
    db = undefined;
});

function seed(): Database {
    const database = new Database(":memory:");
    initializeDatabase(database);
    getOrCreateSessionMeta(database, SESSION);
    appendCompartments(database, SESSION, [
        {
            sequence: 0,
            startMessage: 1,
            endMessage: 2,
            startMessageId: "m-1",
            endMessageId: "m-2",
            title: "first",
            content: "first",
        },
        {
            sequence: 1,
            startMessage: 3,
            endMessage: 4,
            startMessageId: "m-3",
            endMessageId: "m-4",
            title: "second",
            content: "second",
        },
    ]);
    db = database;
    return database;
}

/** A host store reader over `rows` (message id to sequence). */
function reader(rows: Record<string, number>) {
    const seqs = Object.values(rows);
    return {
        earliestSequence: () => (seqs.length > 0 ? Math.min(...seqs) : undefined),
        sequenceForId: (_session: string, id: string | null | undefined) =>
            id ? rows[id] : undefined,
    };
}

test("a store holding the session's rows but not the boundary proves the boundary gone", () => {
    const database = seed();
    const result = checkHistoryBoundary(
        database,
        reader({ "m-1": 1, "m-2": 2, "m-3": 3 }),
        SESSION,
    );
    expect(result?.kind).toBe("repaired");
    expect(getCompartments(database, SESSION).map((row) => row.endMessageId)).toEqual(["m-2"]);
});

test("a store with no rows for the session proves nothing", () => {
    // The wrong store, or one the host has not written yet, must not remove
    // compartments just because it cannot find their messages.
    const database = seed();
    const result = checkHistoryBoundary(database, reader({}), SESSION);
    expect(result).toEqual({ kind: "unknown" });
    expect(getCompartments(database, SESSION)).toHaveLength(2);
});

test("a failing store read never blocks the turn", () => {
    const database = seed();
    const result = checkHistoryBoundary(
        database,
        {
            earliestSequence: () => {
                throw new Error("database is locked");
            },
            sequenceForId: () => undefined,
        },
        SESSION,
    );
    expect(result).toBeUndefined();
    expect(getCompartments(database, SESSION)).toHaveLength(2);
});
