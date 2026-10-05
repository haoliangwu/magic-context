/// <reference types="bun-types" />

import { describe, expect, it, spyOn } from "bun:test";
import { Database } from "../../shared/sqlite";
import { closeQuietly } from "../../shared/sqlite-helpers";
import { acquireCompartmentLease } from "./compartment-lease";
import {
    getCompartments,
    getSessionFacts,
    promoteRecompStaging,
    replaceAllCompartmentState,
    replaceAllCompartmentStateAndBumpDepth,
    replaceAllCompartments,
    saveRecompStagingPass,
} from "./compartment-storage";
import {
    getAverageCompressionDepth,
    getIncrementDepthStatement,
} from "./compression-depth-storage";
import { initializeDatabase } from "./storage-db";

function makeDb(): Database {
    const db = new Database(":memory:");
    initializeDatabase(db);
    return db;
}

const compartment = (sequence: number, start: number, end: number, title = `c${sequence}`) => ({
    sequence,
    startMessage: start,
    endMessage: end,
    startMessageId: `m-${start}`,
    endMessageId: `m-${end}`,
    title,
    content: `content ${sequence}`,
});

describe("atomic compartment state publish", () => {
    it("compartment projection preserves rejection of legacy rows missing required coordinates", () => {
        const db = new Database(":memory:");
        try {
            db.exec(
                "CREATE TABLE compartments(id INTEGER, session_id TEXT, sequence INTEGER, start_message INTEGER, end_message INTEGER, title TEXT, content TEXT, created_at INTEGER)",
            );
            db.exec("INSERT INTO compartments VALUES (1, 'old', 0, 1, 2, 'legacy', 'summary', 0)");
            expect(getCompartments(db, "old")).toEqual([]);
        } finally {
            db.close();
        }
    });
    it("compartment projection omits retired blobs without changing rendered fields", () => {
        const db = makeDb();
        try {
            replaceAllCompartments(db, "projection", [
                {
                    ...compartment(1, 3, 4),
                    p1: "full",
                    p2: "short",
                    importance: 75,
                    episodeType: "coding",
                    endBlockIndex: 2,
                },
                compartment(0, 1, 2),
            ]);
            const before = getCompartments(db, "projection");
            db.prepare(
                "UPDATE compartments SET p1_embedding = ?, p1_embedding_model_id = 'retired' WHERE session_id = 'projection'",
            ).run(Buffer.alloc(128 * 1024));
            const prepare = db.prepare.bind(db);
            let projected: Record<string, unknown>[] = [];
            const spy = spyOn(db, "prepare").mockImplementation((sql: string) => {
                const statement = prepare(sql);
                if (sql.startsWith("SELECT") && sql.includes("FROM compartments")) {
                    const all = statement.all.bind(statement);
                    spyOn(statement, "all").mockImplementation((...args: unknown[]) => {
                        const rows = all(...args) as Record<string, unknown>[];
                        projected = rows;
                        return rows;
                    });
                }
                return statement;
            });
            try {
                expect(getCompartments(db, "projection")).toEqual(before);
                expect(projected).toHaveLength(2);
                expect(projected.every((row) => !("p1_embedding" in row))).toBe(true);
                expect(projected.every((row) => !("p1_embedding_model_id" in row))).toBe(true);
            } finally {
                spy.mockRestore();
            }
        } finally {
            closeQuietly(db);
        }
    });

    it("replaces compartments/facts and bumps the selected depth range atomically", () => {
        const db = makeDb();
        const sessionId = "ses-atomic";
        const holderId = "holder";
        expect(acquireCompartmentLease(db, sessionId, holderId)).not.toBeNull();

        const ok = replaceAllCompartmentStateAndBumpDepth(
            db,
            holderId,
            sessionId,
            [compartment(0, 1, 2), compartment(1, 3, 4)],
            [{ category: "Fact", content: "fresh" }],
            2,
            3,
        );

        expect(ok).toBe(true);
        expect(getCompartments(db, sessionId).map((c) => c.title)).toEqual(["c0", "c1"]);
        expect(getSessionFacts(db, sessionId).map((f) => f.content)).toEqual(["fresh"]);
        expect(getAverageCompressionDepth(db, sessionId, 1, 1)).toBe(0);
        expect(getAverageCompressionDepth(db, sessionId, 2, 3)).toBe(1);
        expect(getAverageCompressionDepth(db, sessionId, 4, 4)).toBe(0);
        closeQuietly(db);
    });

    it("aborts on holder mismatch before deleting old state", () => {
        const db = makeDb();
        const sessionId = "ses-mismatch";
        replaceAllCompartmentState(
            db,
            sessionId,
            [compartment(0, 1, 2, "old")],
            [{ category: "Fact", content: "old fact" }],
        );
        expect(acquireCompartmentLease(db, sessionId, "holder-a")).not.toBeNull();

        const ok = replaceAllCompartmentStateAndBumpDepth(
            db,
            "holder-b",
            sessionId,
            [compartment(0, 1, 2, "new")],
            [{ category: "Fact", content: "new fact" }],
            1,
            2,
        );

        expect(ok).toBe(false);
        expect(getCompartments(db, sessionId).map((c) => c.title)).toEqual(["old"]);
        expect(getSessionFacts(db, sessionId).map((f) => f.content)).toEqual(["old fact"]);
        expect(getAverageCompressionDepth(db, sessionId, 1, 2)).toBe(0);
        closeQuietly(db);
    });

    it("reuses the cached increment-depth statement and increments exact ordinals", () => {
        const db = makeDb();
        const sessionId = "ses-depth";
        const holderId = "holder";
        expect(getIncrementDepthStatement(db)).toBe(getIncrementDepthStatement(db));
        expect(acquireCompartmentLease(db, sessionId, holderId)).not.toBeNull();

        expect(
            replaceAllCompartmentStateAndBumpDepth(
                db,
                holderId,
                sessionId,
                [compartment(0, 1, 5)],
                [],
                2,
                4,
            ),
        ).toBe(true);

        expect(getAverageCompressionDepth(db, sessionId, 1, 1)).toBe(0);
        expect(getAverageCompressionDepth(db, sessionId, 2, 4)).toBe(1);
        expect(getAverageCompressionDepth(db, sessionId, 5, 5)).toBe(0);
        closeQuietly(db);
    });

    it("promoteRecompStaging respects lease holder and preserves old state on stale holder", () => {
        const db = makeDb();
        const sessionId = "ses-promote";
        replaceAllCompartmentState(db, sessionId, [compartment(0, 1, 2, "old")], []);
        saveRecompStagingPass(
            db,
            sessionId,
            1,
            [compartment(0, 1, 2, "new")],
            [{ category: "Fact", content: "new fact" }],
        );
        expect(acquireCompartmentLease(db, sessionId, "holder-a")).not.toBeNull();

        expect(promoteRecompStaging(db, sessionId, "holder-b")).toBeNull();
        expect(getCompartments(db, sessionId).map((c) => c.title)).toEqual(["old"]);

        const promoted = promoteRecompStaging(db, sessionId, "holder-a");
        expect(promoted?.compartments.map((c) => c.title)).toEqual(["new"]);
        expect(getCompartments(db, sessionId).map((c) => c.title)).toEqual(["new"]);
        closeQuietly(db);
    });
});

it("logs every compartment replacement atomically without marking an initial insert", () => {
    for (const kind of ["rows", "state", "depth", "staging", "leased-staging"] as const) {
        const db = makeDb();
        const sessionId = `mutation-${kind}`;
        try {
            const head = () =>
                (
                    db
                        .prepare(
                            "SELECT COUNT(*) AS count FROM m0_mutation_log WHERE session_id = ?",
                        )
                        .get(sessionId) as { count: number }
                ).count;
            replaceAllCompartmentState(db, sessionId, [compartment(0, 1, 2, "old")], []);
            expect(head()).toBe(0);
            expect(acquireCompartmentLease(db, sessionId, "holder")).not.toBeNull();
            const replace = () => {
                const rows = [compartment(0, 1, 3, "new")];
                if (kind === "rows") replaceAllCompartments(db, sessionId, rows);
                else if (kind === "state") replaceAllCompartmentState(db, sessionId, rows, []);
                else if (kind === "depth")
                    expect(
                        replaceAllCompartmentStateAndBumpDepth(
                            db,
                            "holder",
                            sessionId,
                            rows,
                            [],
                            1,
                            3,
                        ),
                    ).toBe(true);
                else {
                    saveRecompStagingPass(db, sessionId, 1, rows, []);
                    expect(
                        promoteRecompStaging(
                            db,
                            sessionId,
                            kind === "leased-staging" ? "holder" : undefined,
                        ),
                    ).not.toBeNull();
                }
            };
            db.exec(
                "CREATE TRIGGER reject_mutation BEFORE INSERT ON m0_mutation_log BEGIN SELECT RAISE(ABORT, 'mutation rejected'); END",
            );
            expect(replace).toThrow("mutation rejected");
            expect(getCompartments(db, sessionId).map((row) => row.title)).toEqual(["old"]);
            expect(head()).toBe(0);
            db.exec("DROP TRIGGER reject_mutation");
            replace();
            expect(getCompartments(db, sessionId).map((row) => row.title)).toEqual(["new"]);
            expect(head()).toBe(1);
        } finally {
            closeQuietly(db);
        }
    }
});
