import { expect, spyOn, test } from "bun:test";
import { withRawMessageProvider } from "../../../hooks/magic-context/read-session-chunk";
import { Database } from "../../../shared/sqlite";
import { runMigrations } from "../migrations";
import { initializeDatabase } from "../storage-db";
import { createPrimer, getActivePrimers, insertPrimerCandidates } from "../storage-primers";
import { buildPrimerSeed } from "./primer-seed";

test("primer fallback and surrounding context are clipped before entering JavaScript", () => {
    const db = new Database(":memory:");
    initializeDatabase(db);
    runMigrations(db);
    const ids = insertPrimerCandidates(db, [
        {
            projectPath: "same",
            harness: "pi",
            sessionId: "origin",
            question: "Q?",
            sourceCompartmentStart: 2,
            sourceCompartmentEnd: 2,
            sourceMessageTime: 1,
            sourceStartMessageId: "a",
            sourceEndMessageId: "b",
        },
    ]);
    createPrimer(db, {
        projectPath: "same",
        question: "Q?",
        totalSupport: 1,
        lastObservedAt: 1,
        sourceCandidateIds: ids,
    });
    const primer = getActivePrimers(db, "same")[0];
    for (let i = 1; i <= 3; i++)
        db.prepare(`INSERT INTO compartments
        (session_id, sequence, start_message, end_message, title, content, created_at)
        VALUES ('origin', ?, ?, ?, ?, ?, 1)`).run(i, i, i, "t".repeat(10_000), "x".repeat(100_000));
    const returnedSizes: number[] = [];
    const prepare = db.prepare.bind(db);
    const querySpy = spyOn(db, "prepare").mockImplementation((sql: string) => {
        const stmt = prepare(sql);
        if (sql.includes("FROM compartments")) {
            const get = stmt.get.bind(stmt);
            const all = stmt.all.bind(stmt);
            stmt.get = (...args: unknown[]) => {
                const row = get(...args);
                returnedSizes.push(JSON.stringify(row).length);
                return row;
            };
            stmt.all = (...args: unknown[]) => {
                const rows = all(...args);
                for (const row of rows) returnedSizes.push(JSON.stringify(row).length);
                return rows;
            };
        }
        return stmt;
    });
    try {
        const seed = withRawMessageProvider("origin", { readMessages: () => [] }, () =>
            buildPrimerSeed(db, primer),
        );
        expect(seed.kind).toBe("closed-book");
        expect(seed.prePost).toContain("(before)");
        expect(seed.prePost).toContain("(after)");
        expect(returnedSizes.length).toBe(4);
        expect(Math.max(...returnedSizes)).toBeLessThan(5_000);
    } finally {
        querySpy.mockRestore();
        db.close();
    }
});
