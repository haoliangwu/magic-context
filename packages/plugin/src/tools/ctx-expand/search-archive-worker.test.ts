import { afterEach, expect, it } from "bun:test";
import { join } from "node:path";
import {
    contextStore,
    fixture,
    hostStore,
    SESSION,
} from "../../features/magic-context/__tests__/host-stalls.fixture";
import { runMessageFtsRowidMapBackfill } from "../../features/magic-context/message-fts-rowid-map";
import {
    getMessageFtsCoverageScansOnThisThreadForTest,
    withMessageFtsSessionFilter,
} from "../../features/magic-context/message-fts-session-filter";
import { closeReadOnlySessionDb } from "../../hooks/magic-context/read-session-db";
import {
    getExactOrdinalScansOnThisThreadForTest,
    readRawSessionMessageIdOrdinalsForRangeFromDb,
    resetExactOrdinalScansOnThisThreadForTest,
} from "../../hooks/magic-context/read-session-raw";
import type { Database } from "../../shared/sqlite";
import {
    getArchiveReadsOnThisThreadForTest,
    renderSearchArchive,
    renderSearchArchiveOffThread,
} from "./search-archive";
import { createCtxExpandTools } from "./tools";

const previousOpenCodeDb = process.env.OPENCODE_DB;
afterEach(() => {
    closeReadOnlySessionDb();
    if (previousOpenCodeDb === undefined) delete process.env.OPENCODE_DB;
    else process.env.OPENCODE_DB = previousOpenCodeDb;
});

function addArchive(db: Database, duplicate = false): void {
    const insert = db.prepare(`INSERT INTO message_history_fts
        (session_id,message_ordinal,message_id,role,content) VALUES (?,?,?,?,?)`);
    for (let n = 1; n <= 5; n++) {
        insert.run(SESSION, n, `pruned-${n}`, n % 2 ? "user" : "assistant", `archive ${n}`);
    }
    if (duplicate) insert.run(SESSION, 2, "duplicate", "user", "second physical row at ordinal 2");
    insert.run("other", 1, "private", "user", "PRIVATE OTHER SESSION");
    // If the host still holds this ID at ordinal 6, omit its indexed copy.
    insert.run(SESSION, 6, "msg_000005", "user", "still present");
}

it("worker archive is byte-identical for mapped and legacy rows in every ctx_expand ordinal mode", async () => {
    const f = fixture();
    const raw = hostStore(join(f.dir, "opencode.db"), 20, 42);
    const db = contextStore(join(f.dir, "context.db"));
    process.env.OPENCODE_DB = join(f.dir, "opencode.db");
    try {
        for (const duplicate of [false, true]) {
            db.exec(
                "DELETE FROM message_history_fts; DELETE FROM message_fts_rowid_map; DELETE FROM message_fts_rowid_map_backfill_state",
            );
            addArchive(db, duplicate);
            for (const backfilled of [false, true]) {
                if (backfilled) await runMessageFtsRowidMapBackfill(db);
                // Duplicate legacy ordinals cannot be represented by the unique ordinal map.
                expect(withMessageFtsSessionFilter(db, SESSION, (mapped) => mapped)).toBe(
                    backfilled && !duplicate,
                );
                for (const args of [
                    { message: 2 },
                    { start: 1, end: 6 },
                    { start: 1, end: 6, verbose: true },
                ]) {
                    const start = "message" in args ? args.message! : args.start!;
                    const end = "message" in args ? args.message! : args.end!;
                    const expected = renderSearchArchive(db, SESSION, start, end, 6000, false, () =>
                        readRawSessionMessageIdOrdinalsForRangeFromDb(raw, SESSION, start, end),
                    );
                    expect(expected).toContain("From the search archive:");
                    expect(
                        await createCtxExpandTools({ db }).ctx_expand.execute(args, {
                            sessionID: SESSION,
                        } as never),
                    ).toBe(expected!);
                }
                for (const budget of [1, 20, 6000]) {
                    for (const archiveOnly of [false, true]) {
                        const expected = renderSearchArchive(
                            db,
                            SESSION,
                            1,
                            6,
                            budget,
                            archiveOnly,
                            () => readRawSessionMessageIdOrdinalsForRangeFromDb(raw, SESSION, 1, 6),
                        );
                        expect(
                            await renderSearchArchiveOffThread(
                                db,
                                SESSION,
                                1,
                                6,
                                budget,
                                archiveOnly,
                            ),
                        ).toBe(expected);
                    }
                }
                expect(await renderSearchArchiveOffThread(db, SESSION, 50, 60, 6000)).toBeNull();
            }
        }
    } finally {
        raw.close();
        db.close();
        f.cleanup();
    }
}, 120000);

it("ctx_expand performs zero exact full-scan, archive, or coverage reads on the main thread", async () => {
    const f = fixture();
    const raw = hostStore(join(f.dir, "opencode.db"), 1000);
    const db = contextStore(join(f.dir, "context.db"));
    process.env.OPENCODE_DB = join(f.dir, "opencode.db");
    try {
        addArchive(db, true);
        resetExactOrdinalScansOnThisThreadForTest();
        const archiveReads = getArchiveReadsOnThisThreadForTest();
        const coverageScans = getMessageFtsCoverageScansOnThisThreadForTest();
        const expand = createCtxExpandTools({ db }).ctx_expand;
        for (const args of [
            { message: 2 },
            { start: 1, end: 6 },
            { start: 1, end: 6, verbose: true },
        ]) {
            expect(await expand.execute(args, { sessionID: SESSION } as never)).toContain(
                "From the search archive:",
            );
        }
        expect(getExactOrdinalScansOnThisThreadForTest()).toBe(0);
        expect(getArchiveReadsOnThisThreadForTest() - archiveReads).toBe(0);
        expect(getMessageFtsCoverageScansOnThisThreadForTest() - coverageScans).toBe(0);
    } finally {
        raw.close();
        db.close();
        f.cleanup();
    }
}, 30000);
