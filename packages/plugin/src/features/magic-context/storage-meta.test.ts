/// <reference types="bun-types" />

import { describe, expect, it, mock } from "bun:test";
import { toDatabase } from "./mock-database";
import { clearSession, updateSessionMeta } from "./storage-meta";
import { SESSION_SCOPED_TABLES } from "./storage-session-tables";

function createMockDb() {
    let inTransaction = false;
    const executions: { sql: string; inTransaction: boolean }[] = [];
    const prepare = mock((sql: string) => ({
        all: mock((..._args: unknown[]) => []),
        // No row: reads see a database whose one-time FTS rowid-map backfill
        // has not finished yet.
        get: mock((..._args: unknown[]) => undefined),
        run: mock((..._args: unknown[]) => {
            executions.push({ sql, inTransaction });
        }),
    }));

    // Mirrors bun:sqlite: the wrapper runs deferred when called and exposes
    // `.immediate()` for writers that take the write lock at BEGIN.
    const transaction = mock((callback: () => void) => {
        const run = () => {
            inTransaction = true;
            try {
                return callback();
            } finally {
                inTransaction = false;
            }
        };
        return Object.assign(run, { immediate: run });
    });

    return {
        prepare,
        transaction,
        executions,
    };
}

describe("storage-meta", () => {
    describe("updateSessionMeta", () => {
        it("runs insert + update inside a transaction", () => {
            //#given
            const db = createMockDb();

            //#when
            updateSessionMeta(toDatabase(db), "session-1", { counter: 3, lastNudgeTokens: 20_000 });

            //#then
            expect(db.transaction).toHaveBeenCalledTimes(1);
            const sqls = db.prepare.mock.calls.map((call: [string]) => call[0]);
            expect(
                sqls.some((sql: string) => sql.includes("INSERT OR IGNORE INTO session_meta")),
            ).toBe(true);
            expect(sqls.some((sql: string) => sql.startsWith("UPDATE session_meta SET"))).toBe(
                true,
            );
        });

        it("does not start a transaction when there are no updates", () => {
            //#given
            const db = createMockDb();

            //#when
            updateSessionMeta(toDatabase(db), "session-1", {});

            //#then
            expect(db.transaction).not.toHaveBeenCalled();
            expect(db.prepare).not.toHaveBeenCalled();
        });

        it("stores null values using the empty-string sentinel", () => {
            //#given
            const db = createMockDb();

            //#when
            updateSessionMeta(toDatabase(db), "session-1", { lastNudgeBand: null });

            //#then
            const updateSqlIndex = db.prepare.mock.calls.findIndex((call: [string]) =>
                call[0].startsWith("UPDATE session_meta SET"),
            );
            expect(updateSqlIndex).toBeGreaterThanOrEqual(0);

            const updateResult = db.prepare.mock.results[updateSqlIndex]?.value as
                | { run: ReturnType<typeof mock> }
                | undefined;
            const updateRun = updateResult?.run;
            expect(updateRun).toHaveBeenCalledWith("", "session-1");
        });
    });

    describe("clearSession", () => {
        it("runs all delete statements in one transaction", () => {
            //#given
            const db = createMockDb();

            //#when
            clearSession(toDatabase(db), "session-1");

            //#then
            // clearSession deletes all owned tables inside one transaction.
            // Delete compartment retry records before their parent compartments, so
            // cleanup can still address each retry. Remove the session activity
            // mark after table rows, but advance the retained identity-change
            // counter: a cache may miss the empty interval before reimport.
            // While the FTS rowid-map backfill is unfinished, two of the
            // statements read its state and sweep the session's unmapped
            // legacy FTS rows.
            expect(db.transaction).toHaveBeenCalledTimes(1);
            // The indexed temporal choices are session-owned too; adding their
            // deletion must not split cleanup across separate transactions.
            expect(db.executions.length).toBeGreaterThan(0);
            expect(db.executions.every((execution) => execution.inTransaction)).toBe(true);
            for (const definition of SESSION_SCOPED_TABLES) {
                expect(
                    db.executions.some((execution) =>
                        execution.sql.trimStart().startsWith(`DELETE FROM ${definition.table}`),
                    ),
                ).toBe(true);
            }
        });
    });
});
