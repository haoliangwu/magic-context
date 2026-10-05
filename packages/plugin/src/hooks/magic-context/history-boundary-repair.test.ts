/// <reference types="bun-types" />

import { afterEach, describe, expect, it } from "bun:test";
import {
    acquireCompartmentLease,
    releaseCompartmentLease,
} from "../../features/magic-context/compartment-lease";
import {
    appendCompartments,
    getCompartments,
    getLastCompartmentEndMessageId,
} from "../../features/magic-context/compartment-storage";
import { getOrCreateSessionMeta } from "../../features/magic-context/storage";
import { initializeDatabase } from "../../features/magic-context/storage-db";
import { Database } from "../../shared/sqlite";
import { closeQuietly } from "../../shared/sqlite-helpers";
import { repairMissingHistoryBoundary } from "./history-boundary-repair";

const SESSION = "ses-history-boundary";

let db: Database | undefined;

afterEach(() => {
    if (db) closeQuietly(db);
    db = undefined;
});

/**
 * Three compartments ending at host messages m-2, m-4 and m-6, and a cached
 * m[0]/m[1] prefix whose recorded boundary is the newest end.
 */
function seed(options: { baseline?: string | null; latestEndId?: string } = {}): Database {
    const database = new Database(":memory:");
    initializeDatabase(database);
    getOrCreateSessionMeta(database, SESSION);
    appendCompartments(
        database,
        SESSION,
        [1, 2, 3].map((index) => ({
            sequence: index - 1,
            startMessage: index * 2 - 1,
            endMessage: index * 2,
            startMessageId: `m-${index * 2 - 1}`,
            endMessageId:
                index === 3 && options.latestEndId !== undefined
                    ? options.latestEndId
                    : `m-${index * 2}`,
            title: `Compartment ${index}`,
            content: `Summary ${index}`,
        })),
    );
    database
        .prepare(
            "UPDATE session_meta SET cached_m0_bytes = ?, cached_m1_bytes = ?, cached_m0_last_baseline_end_message_id = ? WHERE session_id = ?",
        )
        .run(
            Buffer.from("m0"),
            Buffer.from("m1"),
            options.baseline === undefined ? "m-6" : options.baseline,
            SESSION,
        );
    for (const ordinal of [2, 4, 6])
        database
            .prepare(
                "INSERT INTO compression_depth (session_id, message_ordinal, depth, harness) VALUES (?, ?, 1, 'opencode')",
            )
            .run(SESSION, ordinal);
    db = database;
    return database;
}

/** A host store holding exactly `ids`; every other id is a definite "not there". */
function store(ids: string[]): (id: string) => boolean {
    const held = new Set(ids);
    return (id) => held.has(id);
}

function cachedPair(database: Database): { m0: unknown; boundary: string | null } {
    return database
        .prepare(
            "SELECT cached_m0_bytes AS m0, cached_m0_last_baseline_end_message_id AS boundary FROM session_meta WHERE session_id = ?",
        )
        .get(SESSION) as { m0: unknown; boundary: string | null };
}

function depthOrdinals(database: Database): number[] {
    return (
        database
            .prepare(
                "SELECT message_ordinal AS ordinal FROM compression_depth WHERE session_id = ? ORDER BY message_ordinal",
            )
            .all(SESSION) as Array<{ ordinal: number }>
    ).map((row) => row.ordinal);
}

describe("repairMissingHistoryBoundary", () => {
    it("leaves a session alone when the store has the newest compartment end", () => {
        const database = seed();
        const result = repairMissingHistoryBoundary({
            db: database,
            sessionId: SESSION,
            isInHostStore: store(["m-2", "m-4", "m-6"]),
        });
        expect(result).toEqual({ kind: "intact" });
        expect(getCompartments(database, SESSION)).toHaveLength(3);
        expect(cachedPair(database).m0).not.toBeNull();
    });

    it("re-anchors on the newest compartment end the store still has", () => {
        const database = seed();
        const result = repairMissingHistoryBoundary({
            db: database,
            sessionId: SESSION,
            isInHostStore: store(["m-2", "m-4"]),
        });
        expect(result).toEqual({
            kind: "repaired",
            missingEndMessageId: "m-6",
            anchorEndMessageId: "m-4",
            droppedSequences: [2],
        });
        expect(getCompartments(database, SESSION).map((row) => row.endMessageId)).toEqual([
            "m-2",
            "m-4",
        ]);
        // The pair rendered the removed compartment, so it is rebuilt next pass.
        expect(cachedPair(database)).toEqual({ m0: null, boundary: null });
        expect(depthOrdinals(database)).toEqual([2, 4]);
    });

    it("skips older compartments whose ends are gone too and anchors on the newest one left", () => {
        const database = seed();
        const result = repairMissingHistoryBoundary({
            db: database,
            sessionId: SESSION,
            isInHostStore: store(["m-2"]),
        });
        expect(result.kind).toBe("repaired");
        expect(getCompartments(database, SESSION).map((row) => row.endMessageId)).toEqual(["m-2"]);
    });

    it("keeps a newest compartment with no end_message_id (the fork shape) and bounds at the newest id", () => {
        // A compartment without an end id cannot be placed, but that says nothing
        // about the store, so it is kept. The boundary is the newest end id.
        const database = seed({ latestEndId: "", baseline: "m-4" });
        const result = repairMissingHistoryBoundary({
            db: database,
            sessionId: SESSION,
            isInHostStore: store(["m-2", "m-4", "m-6"]),
        });
        expect(result).toEqual({ kind: "intact" });
        expect(getCompartments(database, SESSION)).toHaveLength(3);
        expect(getLastCompartmentEndMessageId(database, SESSION)).toBe("m-4");
    });

    it("re-anchors past an id-less newest compartment when the newest end id is gone", () => {
        const database = seed({ latestEndId: "", baseline: "m-4" });
        const result = repairMissingHistoryBoundary({
            db: database,
            sessionId: SESSION,
            isInHostStore: store(["m-2"]),
        });
        expect(result).toEqual({
            kind: "repaired",
            missingEndMessageId: "m-4",
            anchorEndMessageId: "m-2",
            droppedSequences: [1, 2],
        });
    });

    it("changes nothing when the store cannot answer", () => {
        const database = seed();
        const result = repairMissingHistoryBoundary({
            db: database,
            sessionId: SESSION,
            isInHostStore: () => null,
        });
        expect(result).toEqual({ kind: "unknown" });
        expect(getCompartments(database, SESSION)).toHaveLength(3);
        expect(cachedPair(database).boundary).toBe("m-6");
    });

    it("reports an unresolved boundary when no compartment end is left to anchor on", () => {
        const database = seed();
        const result = repairMissingHistoryBoundary({
            db: database,
            sessionId: SESSION,
            isInHostStore: store([]),
        });
        expect(result).toEqual({
            kind: "unresolved",
            reason: "no-anchor",
            missingEndMessageId: "m-6",
        });
        expect(getCompartments(database, SESSION)).toHaveLength(3);
        expect(cachedPair(database).boundary).toBe("m-6");
    });

    it("waits while another holder owns compartment state", () => {
        const database = seed();
        expect(acquireCompartmentLease(database, SESSION, "historian")).not.toBeNull();
        try {
            const result = repairMissingHistoryBoundary({
                db: database,
                sessionId: SESSION,
                isInHostStore: store(["m-2", "m-4"]),
            });
            expect(result).toEqual({
                kind: "unresolved",
                reason: "busy",
                missingEndMessageId: "m-6",
            });
            expect(getCompartments(database, SESSION)).toHaveLength(3);
        } finally {
            releaseCompartmentLease(database, SESSION, "historian");
        }
    });

    it("clears a cached pair whose boundary the store no longer has", () => {
        const database = seed({ baseline: "m-5" });
        const result = repairMissingHistoryBoundary({
            db: database,
            sessionId: SESSION,
            isInHostStore: store(["m-2", "m-4", "m-6"]),
        });
        expect(result).toEqual({
            kind: "baseline-reset",
            anchorEndMessageId: "m-6",
            staleBaselineId: "m-5",
        });
        expect(getCompartments(database, SESSION)).toHaveLength(3);
        expect(cachedPair(database)).toEqual({ m0: null, boundary: null });
    });

    it("keeps an older cached boundary the store still has: the next priced pass moves it", () => {
        const database = seed({ baseline: "m-4" });
        const result = repairMissingHistoryBoundary({
            db: database,
            sessionId: SESSION,
            isInHostStore: store(["m-2", "m-4", "m-6"]),
        });
        expect(result).toEqual({ kind: "intact" });
        expect(cachedPair(database).boundary).toBe("m-4");
    });

    it("leaves a pair recorded before the first compartment alone", () => {
        // Replaying that cached pair covers none of the compartments, so their raw
        // rows are meant to be served until the next cache-busting pass folds them in.
        const database = seed({ baseline: null });
        expect(
            repairMissingHistoryBoundary({
                db: database,
                sessionId: SESSION,
                isInHostStore: store(["m-2", "m-4", "m-6"]),
            }),
        ).toEqual({ kind: "intact" });
        expect(cachedPair(database).m0).not.toBeNull();
    });
});
