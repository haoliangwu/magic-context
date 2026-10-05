import { describe, expect, it } from "bun:test";
import {
    initializeDatabase,
    runMigrations,
} from "@magic-context/core/features/magic-context/storage";
import { Database } from "@magic-context/core/shared/sqlite";
import {
    countPendingCoordinateRebases,
    formatPendingCoordinateRebases,
    formatUnresolvedCompartmentSession,
    listUnresolvedCompartments,
    supportsCoordinateGenerationReporting,
} from "./doctor-store-generation";

function contextDatabase(): Database {
    const db = new Database(":memory:");
    initializeDatabase(db);
    runMigrations(db);
    return db;
}

function addSession(
    db: Database,
    sessionId: string,
    args: {
        harness?: string;
        generation?: string | null;
        compartments?: number;
        unresolved?: number;
    } = {},
): void {
    db.prepare(
        "INSERT INTO session_meta (session_id, harness, coordinate_generation) VALUES (?, ?, ?)",
    ).run(sessionId, args.harness ?? "opencode", args.generation ?? null);
    const total = args.compartments ?? 0;
    const unresolved = args.unresolved ?? 0;
    for (let sequence = 0; sequence < total; sequence += 1) {
        db.prepare(
            `INSERT INTO compartments
                (session_id, sequence, start_message, end_message, start_message_id,
                 end_message_id, title, content, created_at, rebase_status)
             VALUES (?, ?, 1, 2, 'm1', 'm2', 't', 'c', 1, ?)`,
        ).run(sessionId, sequence, sequence < unresolved ? "unresolved" : "ok");
    }
}

describe("store projection doctor reporting", () => {
    it("reports the database as unsupported before the coordinate columns exist", () => {
        const db = contextDatabase();
        try {
            expect(supportsCoordinateGenerationReporting(db)).toBe(true);
            db.exec("ALTER TABLE session_meta DROP COLUMN coordinate_generation");
            expect(supportsCoordinateGenerationReporting(db)).toBe(false);
        } finally {
            db.close();
        }
    });

    it("counts only sessions that actually hold coordinates, split by recorded projection", () => {
        const db = contextDatabase();
        try {
            addSession(db, "ses-other-projection", { generation: "v1", compartments: 2 });
            addSession(db, "ses-never-recorded", { generation: null, compartments: 1 });
            addSession(db, "ses-current", { generation: "v2", compartments: 3 });
            // No compartment: its stamp is written with no other effect, so it is
            // not work an operator needs to plan for.
            addSession(db, "ses-empty", { generation: null });
            // Pi never moves between OpenCode store projections.
            addSession(db, "ses-pi", { harness: "pi", generation: null, compartments: 4 });

            expect(countPendingCoordinateRebases(db, "v2")).toEqual({
                changed: 1,
                unrecorded: 1,
                current: 1,
            });
            // The same database read from the other host: the counts swap sides.
            expect(countPendingCoordinateRebases(db, "v1")).toEqual({
                changed: 1,
                unrecorded: 1,
                current: 1,
            });
        } finally {
            db.close();
        }
    });

    it("says nothing is waiting when every session is already on this projection", () => {
        const db = contextDatabase();
        try {
            addSession(db, "ses-a", { generation: "v2", compartments: 1 });
            const pending = countPendingCoordinateRebases(db, "v2");

            expect(pending).toEqual({ changed: 0, unrecorded: 0, current: 1 });
            expect(formatPendingCoordinateRebases(pending, "v2")).toBe(
                "All 1 session(s) with compartments are already anchored to this host's v2 store projection",
            );
        } finally {
            db.close();
        }
    });

    it("describes what the next open would re-anchor", () => {
        const db = contextDatabase();
        try {
            addSession(db, "ses-a", { generation: "v1", compartments: 1 });
            addSession(db, "ses-b", { generation: null, compartments: 1 });
            addSession(db, "ses-c", { generation: "v2", compartments: 1 });

            expect(
                formatPendingCoordinateRebases(countPendingCoordinateRebases(db, "v2"), "v2"),
            ).toBe(
                "2 session(s) with compartments would be re-anchored on next open " +
                    "(1 recorded against the other projection, 1 never recorded); 1 already on v2",
            );
        } finally {
            db.close();
        }
    });

    it("ranks the sessions holding compartments that could not be re-anchored", () => {
        const db = contextDatabase();
        try {
            addSession(db, "ses-worst", { generation: "v2", compartments: 9, unresolved: 7 });
            addSession(db, "ses-mid", { generation: "v2", compartments: 4, unresolved: 3 });
            for (const [index, name] of ["a", "b", "c", "d"].entries()) {
                addSession(db, `ses-${name}`, {
                    generation: "v2",
                    compartments: 2,
                    unresolved: index < 4 ? 1 : 0,
                });
            }

            const unresolved = listUnresolvedCompartments(db);
            expect(unresolved.total).toBe(14);
            expect(unresolved.sessions).toBe(6);
            // Highest count first, then session id, capped at five.
            expect(unresolved.top).toEqual([
                { sessionId: "ses-worst", count: 7 },
                { sessionId: "ses-mid", count: 3 },
                { sessionId: "ses-a", count: 1 },
                { sessionId: "ses-b", count: 1 },
                { sessionId: "ses-c", count: 1 },
            ]);
            expect(formatUnresolvedCompartmentSession(unresolved.top[0] as never)).toBe(
                "session=ses-worst unresolved=7",
            );
        } finally {
            db.close();
        }
    });

    it("reads nothing and writes nothing on a store with no unresolved compartment", () => {
        const db = contextDatabase();
        try {
            addSession(db, "ses-a", { generation: "v2", compartments: 3 });

            expect(listUnresolvedCompartments(db)).toEqual({ total: 0, sessions: 0, top: [] });
            // Read-only: doctor must never move a session onto the running projection.
            expect(
                db
                    .prepare(
                        "SELECT coordinate_generation AS generation FROM session_meta WHERE session_id = 'ses-a'",
                    )
                    .get(),
            ).toEqual({ generation: "v2" });
        } finally {
            db.close();
        }
    });
});
