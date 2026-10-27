/// <reference types="bun-types" />

import { Database as ForeignDatabase } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { OPENCODE1_MESSAGE_PART_SCHEMA } from "../../features/magic-context/__tests__/opencode1-query-fixture";
import { scaleTest } from "../../shared/slow-test";
import { Database } from "../../shared/sqlite";
import { createTestTempDir } from "../../shared/test-temp-dir";
import {
    countRawSessionMessageOrdinalsFromDb,
    forgetRawSessionOrdinalWatermark,
    forgetRawSessionSummaryRows,
    getRawSessionSummaryEpoch,
    installRawSessionSummaryScan,
    readRawSessionMessageByIdFromDb,
    readRawSessionMessageOrdinalByIdFromDb,
    scanRawSessionSummaryRows,
} from "./read-session-raw";

const A = "ses-r2-a";
const B = "ses-r2-b";
interface Connection {
    prepare(sql: string): {
        run(...bindings: Array<string | number>): unknown;
        get(...bindings: Array<string | number>): unknown;
    };
}

// Frozen whole-prefix predicate from 6bc65dcc, independent of candidate discovery.
const PREFIX = `SELECT COUNT(*) AS n FROM message WHERE session_id = ?
    AND NOT (COALESCE(json_extract(data, '$.summary'), 0) = 1
        AND COALESCE(json_extract(data, '$.finish'), '') = 'stop')
    AND (time_created, id) <= (?, ?)`;

function put(db: Connection, id: string, time: number, session = A, summary = false): void {
    db.prepare("INSERT INTO message VALUES (?, ?, ?, ?, ?)").run(
        id,
        session,
        time,
        time,
        JSON.stringify(summary ? { role: "assistant", summary: true } : { role: "user" }),
    );
}

function finish(db: Connection, id: string): void {
    db.prepare("UPDATE message SET data = json_set(data, '$.finish', 'stop') WHERE id = ?").run(id);
}

function oracle(db: Connection, session: string, id: string): number | null {
    const row = db
        .prepare("SELECT time_created, data FROM message WHERE session_id = ? AND id = ?")
        .get(session, id) as { time_created: number; data: string } | null;
    if (!row) return null;
    const info = JSON.parse(row.data);
    if (info.summary === true && info.finish === "stop") return null;
    return (db.prepare(PREFIX).get(session, row.time_created, id) as { n: number }).n;
}

function parity(db: Database, session: string, id: string): void {
    const expected = oracle(db, session, id);
    expect({
        session,
        id,
        point: readRawSessionMessageByIdFromDb(db, session, id)?.ordinal ?? null,
        ordinal: readRawSessionMessageOrdinalByIdFromDb(db, session, id),
    }).toEqual({ session, id, point: expected, ordinal: expected });
}

function withFile(run: (reader: Database, writer: ForeignDatabase) => void): void {
    const { dir, cleanup } = createTestTempDir("mc-stall-r2-ordinal-");
    const path = join(dir, "fixture.db");
    const reader = new Database(path);
    const writer = new ForeignDatabase(path);
    try {
        reader.exec(OPENCODE1_MESSAGE_PART_SCHEMA);
        reader.exec("PRAGMA journal_mode = WAL");
        writer.exec("PRAGMA busy_timeout = 1000");
        run(reader, writer);
    } finally {
        writer.close();
        reader.close();
        cleanup();
    }
}

function moveSummary(invalidate: boolean): void {
    withFile((reader, writer) => {
        put(writer, "summary", 1, A, true);
        finish(writer, "summary");
        put(writer, "a-tail", 10);
        put(writer, "b-tail", 10, B);
        parity(reader, A, "a-tail");
        parity(reader, B, "b-tail");
        writer.prepare("UPDATE message SET session_id = ? WHERE id = 'summary'").run(B);
        if (invalidate) forgetRawSessionSummaryRows(B);
        parity(reader, A, "a-tail");
        parity(reader, B, "b-tail");
    });
}

function anchorRace(invalidate: boolean): void {
    withFile((reader, writer) => {
        put(writer, "target", 20);
        put(writer, "top", 30);
        parity(reader, A, "target");
        // Force a fresh count, but retain the summary candidate anchors.
        forgetRawSessionOrdinalWatermark(A);
        const prepare = reader.prepare.bind(reader);
        let interleaved = false;
        reader.prepare = ((sql: string) => {
            if (
                !interleaved &&
                sql.includes("CASE WHEN") &&
                sql.includes("ORDER BY time_created, id LIMIT")
            ) {
                interleaved = true;
                const before = writer
                    .prepare("SELECT rowid AS rid FROM message WHERE id = 'top'")
                    .get() as { rid: number };
                writer.prepare("DELETE FROM message WHERE id = 'top'").run();
                put(writer, "reused-summary", 1, A, true);
                finish(writer, "reused-summary");
                const after = writer
                    .prepare("SELECT rowid AS rid FROM message WHERE id = 'reused-summary'")
                    .get() as { rid: number };
                expect(after.rid).toBe(before.rid);
            }
            return prepare(sql);
        }) as typeof reader.prepare;
        let actual: number | null;
        try {
            actual = readRawSessionMessageOrdinalByIdFromDb(reader, A, "target");
        } finally {
            reader.prepare = prepare;
        }
        expect(interleaved).toBe(true);
        expect(oracle(reader, A, "target")).toBe(1);
        if (invalidate) {
            forgetRawSessionSummaryRows(A);
            actual = readRawSessionMessageOrdinalByIdFromDb(reader, A, "target");
        }
        expect(actual).toBe(1);
        parity(reader, A, "target");
    });
}

describe("stall r2 ordinal witnesses", () => {
    test("rowid reuse between anchor validation and incremental scan must not lose a finished summary", () =>
        anchorRace(false));
    test("rowid reuse race: forgetting candidates restores the whole-prefix result", () =>
        anchorRace(true));
    test("a finished summary moved into an already warm session must be excluded", () =>
        moveSummary(false));
    test("session move: forgetting destination candidates restores the whole-prefix result", () =>
        moveSummary(true));

    test("rows committed during a WAL scan snapshot are counted after installation", () => {
        withFile((reader, writer) => {
            put(writer, "target", 20);
            put(writer, "highest", 30);
            const epoch = getRawSessionSummaryEpoch(A);
            reader.exec("BEGIN");
            // Pin the scanner's snapshot before the writer commits.
            reader.prepare("SELECT COUNT(*) FROM message").get();
            writer.prepare("DELETE FROM message WHERE id = 'highest'").run();
            put(writer, "late-summary", 1, A, true);
            finish(writer, "late-summary");
            const staleScan = scanRawSessionSummaryRows(reader, A);
            expect(staleScan.ids).toEqual([]);
            reader.exec("COMMIT");
            expect(installRawSessionSummaryScan(reader, A, staleScan, epoch)).toBe(false);
            parity(reader, A, "target");
        });
    });
});

type Row = { id: string; session_id: string; time_created: number; data: string; rid: number };

/** Deterministic seeds, 1,000 writes each, using two actual WAL connections. */
function differential(moveSessions: boolean, invalidateMoves: boolean, slow: boolean): void {
    const mismatches: unknown[] = [];
    const operations = Array<number>(10).fill(0);
    for (const seed of slow ? [1, 7, 42, 650, 0x5d0ee2b3, 0xffffffff] : [1, 0xffffffff]) {
        withFile((reader, writer) => {
            let state = seed >>> 0;
            const random = () => (state = (Math.imul(state, 1664525) + 1013904223) >>> 0);
            for (const session of [A, B]) {
                for (let i = 0; i < 12; i++)
                    put(writer, `${session}-seed-${i}`, i % 4, session, i % 3 === 0);
                put(writer, `${session}-tail`, 10000, session);
                parity(reader, session, `${session}-tail`);
            }
            for (let step = 0; step < 1000; step++) {
                const connection: Connection = step % 2 ? writer : reader;
                const rows = writer
                    .prepare(
                        "SELECT rowid AS rid, * FROM message WHERE id NOT LIKE '%-tail' ORDER BY id",
                    )
                    .all() as Row[];
                const victim = rows[random() % rows.length];
                const session = random() % 2 ? A : B;
                const op = step % 10;
                operations[op]++;
                switch (op) {
                    case 0:
                    case 1:
                        put(connection, `s${seed}-${step}`, random() % 8, session, op === 0);
                        break;
                    case 2: {
                        const candidates = rows.filter(
                            (row) => JSON.parse(row.data).summary === true,
                        );
                        if (candidates.length)
                            finish(connection, candidates[random() % candidates.length].id);
                        break;
                    }
                    case 3:
                        connection.prepare("DELETE FROM message WHERE id = ?").run(victim.id);
                        break;
                    case 4:
                        connection
                            .prepare("UPDATE message SET time_created = ? WHERE id = ?")
                            .run(random() % 8, victim.id);
                        break;
                    case 5: {
                        put(connection, `top-to-delete-${seed}-${step}`, 30, session);
                        const top = writer
                            .prepare(
                                "SELECT rowid AS rid, * FROM message ORDER BY rowid DESC LIMIT 1",
                            )
                            .get() as Row;
                        connection.prepare("DELETE FROM message WHERE id = ?").run(top.id);
                        put(connection, `s${seed}-${step}`, 2, session, true);
                        finish(connection, `s${seed}-${step}`);
                        expect(
                            (
                                writer
                                    .prepare("SELECT rowid AS rid FROM message WHERE id = ?")
                                    .get(`s${seed}-${step}`) as { rid: number }
                            ).rid,
                        ).toBe(top.rid);
                        break;
                    }
                    case 6: {
                        const candidates = rows.filter(
                            (row) => JSON.parse(row.data).summary === true,
                        );
                        if (candidates.length) {
                            const row = candidates[random() % candidates.length];
                            connection.prepare("DELETE FROM message WHERE id = ?").run(row.id);
                            put(connection, row.id, random() % 8, row.session_id, true);
                            finish(connection, row.id);
                        }
                        break;
                    }
                    case 7:
                        // Revert a timestamp suffix, retaining the permanent lookup targets.
                        connection
                            .prepare(
                                "DELETE FROM message WHERE session_id = ? AND time_created > 5 AND id NOT LIKE '%-tail'",
                            )
                            .run(session);
                        break;
                    case 8:
                        if (moveSessions) {
                            const destination = victim.session_id === A ? B : A;
                            connection
                                .prepare("UPDATE message SET session_id = ? WHERE id = ?")
                                .run(destination, victim.id);
                            if (invalidateMoves) forgetRawSessionSummaryRows(destination);
                        } else {
                            connection
                                .prepare("UPDATE message SET time_created = 0 WHERE id = ?")
                                .run(victim.id);
                        }
                        break;
                    case 9: {
                        // Install an older scanner snapshot after a second connection appended.
                        forgetRawSessionSummaryRows(session);
                        const epoch = getRawSessionSummaryEpoch(session);
                        const scan = scanRawSessionSummaryRows(reader, session);
                        put(writer, `s${seed}-${step}`, 1, session, true);
                        finish(writer, `s${seed}-${step}`);
                        expect(installRawSessionSummaryScan(reader, session, scan, epoch)).toBe(
                            false,
                        );
                        break;
                    }
                }
                for (const s of [A, B]) {
                    const target = `${s}-tail`;
                    const expected = oracle(reader, s, target);
                    const point =
                        readRawSessionMessageByIdFromDb(reader, s, target)?.ordinal ?? null;
                    const ordinal = readRawSessionMessageOrdinalByIdFromDb(reader, s, target);
                    const count = (
                        reader.prepare(PREFIX).get(s, Number.MAX_SAFE_INTEGER, "\uffff") as {
                            n: number;
                        }
                    ).n;
                    const indexedCount = countRawSessionMessageOrdinalsFromDb(reader, s);
                    if (point !== expected || ordinal !== expected || indexedCount !== count)
                        if (mismatches.length < 8)
                            mismatches.push({
                                seed,
                                step,
                                s,
                                expected,
                                point,
                                ordinal,
                                count,
                                indexedCount,
                            });
                }
            }
        });
    }
    expect(operations).toEqual(Array(10).fill(slow ? 600 : 200));
    expect(mismatches).toEqual([]);
}

// Each full slow-lane variant runs 6,000 steps on two connections and needs
// more headroom than the unit suite's default timeout on a loaded host.
const DIFFERENTIAL_TIMEOUT_MS = 120_000;

scaleTest(
    "ordinal differential: compaction, ties, time moves, suffix deletes, reused rowids, reinserted summaries and scan interleaving",
    (slow) => differential(false, false, slow),
    DIFFERENTIAL_TIMEOUT_MS,
);
scaleTest(
    "ordinal differential: session moves must also match the old whole-prefix count",
    (slow) => differential(true, false, slow),
    DIFFERENTIAL_TIMEOUT_MS,
);
scaleTest(
    "ordinal differential: invalidating destinations of session moves restores parity",
    (slow) => differential(true, true, slow),
    DIFFERENTIAL_TIMEOUT_MS,
);
