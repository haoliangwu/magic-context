/// <reference types="bun-types" />
import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { loadPersistedLkgSlot, saveLkgSlotToDb } from "../../hooks/magic-context/lkg-persist";
import type { LkgSlot } from "../../hooks/magic-context/lkg-slot";
import { Database } from "../../shared/sqlite";
import { cleanupTestTempDir, createTestTempDir } from "../../shared/test-temp-dir";
import { LKG_PREFIX_CHUNK_CHARS, splitLkgPrefix } from "./lkg-prefix-chunks";
import { MIGRATIONS, runMigrations } from "./migrations";
import { initializeDatabase } from "./storage-db";
import {
    addTrailingBlankDecisions,
    demoteTrailingBlankKeepDecisions,
    getTrailingBlankDecisions,
} from "./storage-meta-persisted";
import { clearSession } from "./storage-meta-session";
import {
    addNativeReasoningIds,
    getNativeReplayState,
    saveNativeToolInputs,
} from "./storage-native-replay";
import { parseReplayDocument, readReplayDocument } from "./storage-replay-document";
import { deleteSessionScopedRows } from "./storage-session-tables";

const directories: string[] = [];

afterEach(() => {
    for (const directory of directories.splice(0)) {
        cleanupTestTempDir(directory);
    }
});

function tempDbPath(): string {
    const { dir: directory } = createTestTempDir("magic-context-v94-");
    directories.push(directory);
    return join(directory, "context.db");
}

/** A database whose schema is exactly what migrations 1 to 93 produce. */
function v93Database(path = ":memory:"): Database {
    const db = new Database(path);
    initializeDatabase(db);
    // initializeDatabase already creates the migration-94 tables; remove them and
    // rebuild lkg_slots through migration 81 to exercise an actual upgrade from 93.
    db.exec(`
        DROP TABLE lkg_slot_chunks;
        DROP TABLE session_replay_decisions;
        DROP TABLE lkg_slots;
        CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL, description TEXT);
    `);
    for (const migration of MIGRATIONS.filter((m) => m.version <= 93)) {
        migration.up(db);
        db.prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (?, 0)").run(
            migration.version,
        );
    }
    return db;
}

/** The statement the v93 build's saveLkgSlotToDb ran: the whole prefix in one column. */
function saveV93LkgSlot(db: Database, sessionId: string, slot: LkgSlot): void {
    db.prepare(
        `INSERT INTO lkg_slots (
            session_id, json_prefix, input_id_seq, input_content_digests,
            input_content_signatures, last_input_message_id, model_key, provider_key,
            captured_at, row_version, capture_sequence
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
        sessionId,
        slot.jsonPrefix,
        JSON.stringify(
            slot.piOutputEntryIds
                ? { version: 1, inputIds: slot.inputIdSeq, piOutputEntryIds: slot.piOutputEntryIds }
                : slot.inputIdSeq,
        ),
        JSON.stringify(slot.inputContentDigests),
        slot.inputContentSignatures ? JSON.stringify(slot.inputContentSignatures) : null,
        slot.lastInputMessageId,
        slot.modelKey,
        slot.providerKey,
        slot.capturedAt,
        slot.rowVersion ?? null,
        slot.captureSequence ?? null,
    );
}

/**
 * A prefix of about three slices whose first slice boundary would fall between
 * the halves of a surrogate pair.
 */
function largePrefix(): string {
    const head = '[{"text":"';
    const filler = "a".repeat(LKG_PREFIX_CHUNK_CHARS - 1 - head.length);
    // Leaves room for a few appended messages before a fourth slice starts.
    return `${head}${filler}\u{1F600}${"b".repeat(2 * LKG_PREFIX_CHUNK_CHARS - 200)}"}]`;
}

function appendMessage(prefix: string, text: string): string {
    return `${prefix.slice(0, -1)},{"text":${JSON.stringify(text)}}]`;
}

function slotFor(jsonPrefix: string, capturedAt = Date.now()): LkgSlot {
    const count = (JSON.parse(jsonPrefix) as unknown[]).length;
    const ids = Array.from({ length: count }, (_, index) => `m${index}`);
    return {
        jsonPrefix,
        inputIdSeq: ids,
        inputContentDigests: ids.map((id) => `digest-${id}`),
        lastInputMessageId: ids[ids.length - 1] ?? "m0",
        modelKey: "anthropic/claude",
        providerKey: "anthropic",
        capturedAt,
        rowVersion: 7,
        captureSequence: 3,
    };
}

function totalChanges(db: Database): number {
    return (db.prepare("SELECT total_changes() AS n").get() as { n: number }).n;
}

function columns(db: Database, table: string): string[] {
    return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(
        (column) => column.name,
    );
}

function chunkCount(db: Database, sessionId: string): number {
    return (
        db
            .prepare("SELECT count(*) AS n FROM lkg_slot_chunks WHERE session_id = ?")
            .get(sessionId) as { n: number }
    ).n;
}

function rawDocument(db: Database, sessionId: string): unknown {
    return (
        db
            .prepare("SELECT trailing_blank_decisions AS d FROM session_meta WHERE session_id = ?")
            .get(sessionId) as { d: unknown } | undefined
    )?.d;
}

function insertRawDocument(db: Database, sessionId: string, document: string): void {
    db.prepare("INSERT INTO session_meta (session_id, trailing_blank_decisions) VALUES (?, ?)").run(
        sessionId,
        document,
    );
}

function capture<T>(read: () => T): { value?: T; error?: string } {
    try {
        return { value: read() };
    } catch (error) {
        return { error: error instanceof Error ? error.message : String(error) };
    }
}

/** Everything a replay reader can observe about one session's document. */
function observeReplay(db: Database, sessionId: string, visibleIds: string[]) {
    return {
        strict: capture(() => readReplayDocument(db, sessionId)),
        lenient: capture(() => readReplayDocument(db, sessionId, "read")),
        all: capture(() => getTrailingBlankDecisions(db, sessionId)),
        visible: capture(() => getTrailingBlankDecisions(db, sessionId, visibleIds)),
        native: capture(() => getNativeReplayState(db, sessionId)),
    };
}

describe("migration v94: LKG prefixes as slices", () => {
    test("moves slots captured in the last day into verified slices and drops older ones", () => {
        const db = v93Database();
        try {
            const now = Date.now();
            const opencode = slotFor(largePrefix(), now);
            const pi: LkgSlot = {
                ...slotFor('[{"role":"user"},{"role":"assistant"}]', now),
                piOutputEntryIds: ["m0", null],
            };
            const stale = slotFor('[{"text":"old"}]', now - 2 * 24 * 60 * 60 * 1000);
            const recent = slotFor('[{"text":"recent"}]', now - 23 * 60 * 60 * 1000);
            saveV93LkgSlot(db, "opencode", opencode);
            saveV93LkgSlot(db, "pi", pi);
            saveV93LkgSlot(db, "stale", stale);
            saveV93LkgSlot(db, "recent", recent);

            runMigrations(db);

            expect(columns(db, "lkg_slots")).not.toContain("json_prefix");
            expect(columns(db, "lkg_slots")).toEqual(
                expect.arrayContaining([
                    "json_prefix_chars",
                    "json_prefix_chunks",
                    "json_prefix_hash",
                ]),
            );
            const slices = splitLkgPrefix(opencode.jsonPrefix);
            expect(slices.length).toBe(3);
            // The first boundary moved back one UTF-16 code unit to keep the surrogate pair whole.
            expect(slices[0]?.length).toBe(LKG_PREFIX_CHUNK_CHARS - 1);
            expect(chunkCount(db, "opencode")).toBe(3);
            expect(loadPersistedLkgSlot(db, "opencode")).toEqual(opencode);
            expect(loadPersistedLkgSlot(db, "pi")).toEqual(pi);
            expect(loadPersistedLkgSlot(db, "recent")).toEqual(recent);
            expect(loadPersistedLkgSlot(db, "stale")).toBeUndefined();
            expect(chunkCount(db, "stale")).toBe(0);
        } finally {
            db.close();
        }
    });

    test("serves identical prefixes across migrate, pass, restart, pass; each pass writes only changed slices", () => {
        const path = tempDbPath();
        const first = slotFor(largePrefix());
        const second = slotFor(appendMessage(first.jsonPrefix, "second pass"));
        const third = slotFor(appendMessage(second.jsonPrefix, "after restart"));

        const before = v93Database(path);
        try {
            saveV93LkgSlot(before, "ses", first);
            runMigrations(before);
            expect(loadPersistedLkgSlot(before, "ses")?.jsonPrefix).toBe(first.jsonPrefix);

            const start = totalChanges(before);
            expect(saveLkgSlotToDb(before, "ses", second)).toBe(true);
            // Two row changes: the last slice and the metadata row. The first two
            // slices are not rewritten.
            expect(totalChanges(before) - start).toBe(2);
            expect(loadPersistedLkgSlot(before, "ses")).toEqual(second);
        } finally {
            before.close();
        }

        // A new connection stands in for a restarted process: no state kept in
        // memory by the first connection carries over.
        const after = new Database(path);
        try {
            initializeDatabase(after);
            runMigrations(after);
            // The first save after a restart, with no load before it, still writes
            // only the changed slice: it compares against the stored slice hashes.
            const start = totalChanges(after);
            expect(saveLkgSlotToDb(after, "ses", third)).toBe(true);
            expect(totalChanges(after) - start).toBe(2);
            expect(loadPersistedLkgSlot(after, "ses")).toEqual(third);
            expect(chunkCount(after, "ses")).toBe(3);
        } finally {
            after.close();
        }
    });

    test("a shrinking prefix deletes the slices past its new end", () => {
        const db = v93Database();
        try {
            runMigrations(db);
            const large = slotFor(largePrefix());
            const small = slotFor('[{"text":"short"}]');
            expect(saveLkgSlotToDb(db, "ses", large)).toBe(true);
            expect(chunkCount(db, "ses")).toBe(3);
            expect(saveLkgSlotToDb(db, "ses", small)).toBe(true);
            expect(chunkCount(db, "ses")).toBe(1);
            expect(loadPersistedLkgSlot(db, "ses")).toEqual(small);
        } finally {
            db.close();
        }
    });
});

describe("LKG slices never replay a torn or mixed prefix", () => {
    function migratedWithSlot(): { db: Database; slot: LkgSlot } {
        const db = v93Database();
        runMigrations(db);
        const slot = slotFor(largePrefix());
        expect(saveLkgSlotToDb(db, "ses", slot)).toBe(true);
        return { db, slot };
    }

    test("a missing slice clears the slot", () => {
        const { db } = migratedWithSlot();
        try {
            db.prepare("DELETE FROM lkg_slot_chunks WHERE session_id = 'ses' AND chunk = 1").run();
            expect(loadPersistedLkgSlot(db, "ses")).toBeUndefined();
            expect(db.prepare("SELECT 1 FROM lkg_slots WHERE session_id = 'ses'").get()).toBeNull();
            expect(chunkCount(db, "ses")).toBe(0);
        } finally {
            db.close();
        }
    });

    test("an extra slice past the recorded count clears the slot", () => {
        const { db } = migratedWithSlot();
        try {
            db.prepare(
                "INSERT INTO lkg_slot_chunks (session_id, chunk, hash, body) VALUES ('ses', 3, 'h', 'x')",
            ).run();
            expect(loadPersistedLkgSlot(db, "ses")).toBeUndefined();
        } finally {
            db.close();
        }
    });

    test("a slice replaced by a same-length body clears the slot", () => {
        const { db } = migratedWithSlot();
        try {
            db.prepare(
                "UPDATE lkg_slot_chunks SET body = replace(body, 'b', 'c') WHERE session_id = 'ses' AND chunk = 2",
            ).run();
            expect(loadPersistedLkgSlot(db, "ses")).toBeUndefined();
        } finally {
            db.close();
        }
    });

    test("a failed save rolls back its slices with the row and the previous prefix still loads", () => {
        const { db, slot } = migratedWithSlot();
        try {
            db.exec(`
                CREATE TRIGGER fail_lkg_row BEFORE UPDATE ON lkg_slots
                BEGIN SELECT RAISE(ABORT, 'injected lkg row failure'); END;
            `);
            const next = slotFor(appendMessage(slot.jsonPrefix, "lost"));
            expect(saveLkgSlotToDb(db, "ses", next)).toBe(false);
            db.exec("DROP TRIGGER fail_lkg_row");
            expect(loadPersistedLkgSlot(db, "ses")).toEqual(slot);
        } finally {
            db.close();
        }
    });

    test("a save after another connection's save rewrites the slices that differ from what is stored", () => {
        const path = tempDbPath();
        const setup = v93Database(path);
        runMigrations(setup);
        setup.close();
        const a = new Database(path);
        const b = new Database(path);
        try {
            const base = largePrefix();
            const first = slotFor(base);
            // Differs from `first` in the first slice only.
            const other = slotFor(`[{"text":"Z${base.slice('[{"text":"'.length + 1)}`);
            const third = slotFor(appendMessage(base, "third"));
            expect(saveLkgSlotToDb(a, "ses", first)).toBe(true);
            expect(saveLkgSlotToDb(b, "ses", other)).toBe(true);
            // `a` last saved the slices of `first`, but `b` has since replaced the
            // stored first slice with the one from `other`.
            expect(saveLkgSlotToDb(a, "ses", third)).toBe(true);
            expect(loadPersistedLkgSlot(b, "ses")).toEqual(third);
        } finally {
            a.close();
            b.close();
        }
    });
});

describe("migration v94: replay decisions as rows", () => {
    function populatedV93(path?: string): Database {
        const db = v93Database(path);
        // Written through the public APIs while the schema has no decision table,
        // so they land in the column exactly as the v93 build stored them.
        expect(
            addTrailingBlankDecisions(db, "v1", [
                ["version", "keep"],
                ["a1", "strip"],
                ["a2", "keep:3"],
                ["__proto__", "keep"],
            ]),
        ).toBe(true);
        expect(
            addTrailingBlankDecisions(db, "v2", [
                ["b1", "keep"],
                ["b2", "strip"],
            ]),
        ).toBe(true);
        saveNativeToolInputs(db, "v2", new Map([["call-1", '{"path":"src/a.ts"}']]));
        addNativeReasoningIds(db, "v2", ["r1"]);
        expect(demoteTrailingBlankKeepDecisions(db, "v2", ["b1"])).toEqual(["b1"]);
        insertRawDocument(db, "unknown-version", '{"version":99,"trailingBlank":{"c1":"keep"}}');
        insertRawDocument(db, "invalid-entry", '{"d1":"keep","d2":42}');
        insertRawDocument(db, "invalid-version-id", '{"version":"bogus","e1":"keep"}');
        insertRawDocument(db, "not-json", "{not json");
        insertRawDocument(
            db,
            "v2-invalid-entry",
            '{"version":2,"trailingBlank":{"f1":"keep","f2":"keep:1"}}',
        );
        insertRawDocument(db, "v1-leading-zero", '{"g1":"keep:02"}');
        insertRawDocument(
            db,
            "v2-real-version",
            '{"version":2.0,"trailingBlank":{"h1":"keep:10000"}}',
        );
        return db;
    }

    const sessions: Record<string, string[]> = {
        v1: ["version", "a1", "a2", "__proto__", "missing"],
        v2: ["b1", "b2", "missing"],
        "unknown-version": ["c1"],
        "invalid-entry": ["d1", "d2"],
        "invalid-version-id": ["e1"],
        "not-json": ["x"],
        "v2-invalid-entry": ["f1", "f2"],
        "v1-leading-zero": ["g1"],
        "v2-real-version": ["h1"],
    };

    test("readers observe identical documents, decisions and native lanes before and after", () => {
        const db = populatedV93();
        try {
            const before = Object.fromEntries(
                Object.entries(sessions).map(([id, visible]) => [
                    id,
                    observeReplay(db, id, visible),
                ]),
            );
            runMigrations(db);
            const after = Object.fromEntries(
                Object.entries(sessions).map(([id, visible]) => [
                    id,
                    observeReplay(db, id, visible),
                ]),
            );
            expect(after).toEqual(before);
            // Sanity: the observations carry real data, not only errors.
            expect(before.v1?.all.value?.get("version")).toBe("keep");
            expect(before.v2?.native.value?.toolInputs.get("call-1")).toBe('{"path":"src/a.ts"}');
        } finally {
            db.close();
        }
    });

    test("moves strictly valid documents into rows, a v1 assistant named version included", () => {
        const db = populatedV93();
        try {
            runMigrations(db);
            const rows = db
                .prepare(
                    "SELECT session_id, message_id, decision FROM session_replay_decisions ORDER BY session_id, message_id",
                )
                .all();
            expect(rows).toEqual([
                { session_id: "v1", message_id: "__proto__", decision: "keep" },
                { session_id: "v1", message_id: "a1", decision: "strip" },
                { session_id: "v1", message_id: "a2", decision: "keep:3" },
                { session_id: "v1", message_id: "version", decision: "keep" },
                { session_id: "v2", message_id: "b1", decision: "strip" },
                { session_id: "v2", message_id: "b2", decision: "strip" },
                { session_id: "v2-real-version", message_id: "h1", decision: "keep:10000" },
            ]);
            expect(rawDocument(db, "v1")).toBe("");
            const envelope = parseReplayDocument(rawDocument(db, "v2") as string);
            expect(envelope.version).toBe(2);
            expect(envelope.trailingBlank).toEqual({});
            expect(envelope.piNative).toEqual({
                toolInputs: { "call-1": '{"path":"src/a.ts"}' },
                reasoningIds: ["r1"],
            });
            // Documents that do not parse strictly stay byte-identical in the column.
            expect(rawDocument(db, "unknown-version")).toBe(
                '{"version":99,"trailingBlank":{"c1":"keep"}}',
            );
            expect(rawDocument(db, "invalid-entry")).toBe('{"d1":"keep","d2":42}');
            expect(rawDocument(db, "invalid-version-id")).toBe('{"version":"bogus","e1":"keep"}');
            expect(rawDocument(db, "not-json")).toBe("{not json");
            expect(rawDocument(db, "v1-leading-zero")).toBe('{"g1":"keep:02"}');
        } finally {
            db.close();
        }
    });

    test("writers keep their rules after the move: strict refusals, absorbing strip, live refresh", () => {
        const db = populatedV93();
        try {
            runMigrations(db);
            expect(addTrailingBlankDecisions(db, "unknown-version", [["c2", "keep"]])).toBe(false);
            expect(addTrailingBlankDecisions(db, "invalid-entry", [["d3", "keep"]])).toBe(false);
            expect(
                addTrailingBlankDecisions(db, "v1", [["a1", "keep"]], { overwriteMessageId: "a1" }),
            ).toBe(true);
            expect(
                addTrailingBlankDecisions(db, "v1", [["a2", "keep:4"]], {
                    overwriteMessageId: "a2",
                }),
            ).toBe(true);
            expect(getTrailingBlankDecisions(db, "v1", ["a1", "a2"])).toEqual(
                new Map([
                    ["a1", "strip"],
                    ["a2", "keep:4"],
                ]),
            );
            // A native write after the move leaves the decision rows alone.
            saveNativeToolInputs(db, "v2", new Map([["call-2", "{}"]]));
            expect(getTrailingBlankDecisions(db, "v2")).toEqual(
                new Map([
                    ["b1", "strip"],
                    ["b2", "strip"],
                ]),
            );
        } finally {
            db.close();
        }
    });

    test("decisions are identical across migrate, pass, restart, pass", () => {
        const path = tempDbPath();
        const db = populatedV93(path);
        const expected = new Map(getTrailingBlankDecisions(db, "v2", ["b1", "b2", "b3", "b4"]));
        try {
            runMigrations(db);
            expect(getTrailingBlankDecisions(db, "v2", ["b1", "b2", "b3", "b4"])).toEqual(expected);
            expect(addTrailingBlankDecisions(db, "v2", [["b3", "keep"]])).toBe(true);
            expected.set("b3", "keep");
            expect(getTrailingBlankDecisions(db, "v2", ["b1", "b2", "b3", "b4"])).toEqual(expected);
        } finally {
            db.close();
        }
        const reopened = new Database(path);
        try {
            initializeDatabase(reopened);
            runMigrations(reopened);
            expect(getTrailingBlankDecisions(reopened, "v2", ["b1", "b2", "b3", "b4"])).toEqual(
                expected,
            );
            expect(addTrailingBlankDecisions(reopened, "v2", [["b4", "strip"]])).toBe(true);
            expected.set("b4", "strip");
            expect(getTrailingBlankDecisions(reopened, "v2", ["b1", "b2", "b3", "b4"])).toEqual(
                expected,
            );
            expect(getTrailingBlankDecisions(reopened, "v2")).toEqual(expected);
        } finally {
            reopened.close();
        }
    });

    test("a concurrent strip is never overwritten by a stale keep refresh", () => {
        const db = v93Database();
        try {
            runMigrations(db);
            expect(addTrailingBlankDecisions(db, "ses", [["live", "keep"]])).toBe(true);
            const originalPrepare = db.prepare;
            let interleaved = false;
            db.prepare = ((sql: string) => {
                const statement = originalPrepare.call(db, sql);
                if (
                    !interleaved &&
                    sql
                        .trimStart()
                        .startsWith("SELECT message_id, decision FROM session_replay_decisions")
                ) {
                    const mutable = statement as unknown as {
                        all: (...args: unknown[]) => unknown;
                    };
                    const all = mutable.all.bind(statement);
                    mutable.all = (...args: unknown[]) => {
                        const rows = all(...args);
                        if (!interleaved) {
                            interleaved = true;
                            // Another writer demotes the live keep between this
                            // writer's read and its write.
                            originalPrepare
                                .call(
                                    db,
                                    "UPDATE session_replay_decisions SET decision = 'strip' WHERE session_id = 'ses' AND message_id = 'live'",
                                )
                                .run();
                        }
                        return rows;
                    };
                }
                return statement;
            }) as typeof db.prepare;
            try {
                expect(
                    addTrailingBlankDecisions(db, "ses", [["live", "keep:2"]], {
                        overwriteMessageId: "live",
                    }),
                ).toBe(true);
            } finally {
                db.prepare = originalPrepare;
            }
            expect(interleaved).toBe(true);
            expect(getTrailingBlankDecisions(db, "ses")).toEqual(new Map([["live", "strip"]]));
        } finally {
            db.close();
        }
    });
});

describe("migration v94: session cleanup reaches the new tables", () => {
    test("clearing or sweeping a session removes its slices and decision rows", () => {
        const db = v93Database();
        try {
            runMigrations(db);
            for (const sessionId of ["cleared", "swept", "kept"]) {
                expect(saveLkgSlotToDb(db, sessionId, slotFor('[{"text":"x"}]'))).toBe(true);
                expect(addTrailingBlankDecisions(db, sessionId, [["a", "keep"]])).toBe(true);
            }
            clearSession(db, "cleared");
            deleteSessionScopedRows(db, ["swept"]);
            const remaining = (table: string) =>
                (
                    db
                        .prepare(`SELECT DISTINCT session_id FROM ${table} ORDER BY session_id`)
                        .all() as Array<{
                        session_id: string;
                    }>
                ).map((row) => row.session_id);
            expect(remaining("lkg_slot_chunks")).toEqual(["kept"]);
            expect(remaining("lkg_slots")).toEqual(["kept"]);
            expect(remaining("session_replay_decisions")).toEqual(["kept"]);
        } finally {
            db.close();
        }
    });
});
