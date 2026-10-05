/// <reference types="bun-types" />

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "../../shared/sqlite";
import { createTestTempDirFromPath } from "../../shared/test-temp-dir";
import { runMigrations } from "./migrations";
import { initializeDatabase, LATEST_SUPPORTED_VERSION } from "./storage-db";
import {
    addTrailingBlankDecisions,
    demoteTrailingBlankKeepDecisions,
    getTrailingBlankDecisions,
} from "./storage-meta-persisted";
import {
    addNativeReasoningIds,
    getNativeReasoningIds,
    getNativeReplayState,
    getNativeToolInputs,
    saveNativeToolInputs,
} from "./storage-native-replay";
import {
    parseReplayDocument,
    readReplayDocument,
    serializeReplayDocument,
} from "./storage-replay-document";

function createTestDb(): Database {
    const db = new Database(":memory:");
    initializeDatabase(db);
    runMigrations(db);
    return db;
}

function replayDocumentRaw(db: Database, sessionId: string): string | null {
    const row = db
        .prepare("SELECT trailing_blank_decisions FROM session_meta WHERE session_id = ?")
        .get(sessionId) as { trailing_blank_decisions?: string | null } | undefined;
    return row?.trailing_blank_decisions ?? null;
}

function decisionRows(
    db: Database,
    sessionId: string,
): Array<{ message_id: string; decision: string }> {
    return db
        .prepare(
            "SELECT message_id, decision FROM session_replay_decisions WHERE session_id = ? ORDER BY message_id",
        )
        .all(sessionId) as Array<{ message_id: string; decision: string }>;
}

// Statements that write a trailing-blank decision (one row each) or the replay
// envelope column (the native lanes and other namespaces).
const DECISION_WRITE_PREFIXES = [
    "INSERT INTO session_replay_decisions",
    "UPDATE session_replay_decisions",
];
const ENVELOPE_WRITE_PREFIX = "UPDATE session_meta SET trailing_blank_decisions = ?";

function interleaveFirstReplayWrite(
    db: Database,
    prefixes: readonly string[],
    interleave: () => void,
): () => void {
    const originalPrepare = db.prepare;
    let interleaved = false;
    db.prepare = ((sql: string) => {
        const statement = originalPrepare.call(db, sql);
        if (!interleaved && prefixes.some((prefix) => sql.trimStart().startsWith(prefix))) {
            const mutableStatement = statement as unknown as {
                run: (...args: unknown[]) => unknown;
            };
            const originalRun = mutableStatement.run.bind(statement);
            mutableStatement.run = (...args: unknown[]) => {
                if (!interleaved) {
                    interleaved = true;
                    interleave();
                }
                return originalRun(...args);
            };
        }
        return statement;
    }) as typeof db.prepare;

    return () => {
        db.prepare = originalPrepare;
    };
}
function exhaustReplayDocumentCas(db: Database): () => void {
    const originalPrepare = db.prepare;
    db.prepare = ((sql: string) => {
        const statement = originalPrepare.call(db, sql);
        if (
            [ENVELOPE_WRITE_PREFIX, ...DECISION_WRITE_PREFIXES].some((prefix) =>
                sql.trimStart().startsWith(prefix),
            )
        ) {
            const mutableStatement = statement as unknown as {
                run: (...args: unknown[]) => unknown;
            };
            mutableStatement.run = () => ({ changes: 0 });
        }
        return statement;
    }) as typeof db.prepare;

    return () => {
        db.prepare = originalPrepare;
    };
}

describe("native replay storage", () => {
    let db: Database;

    beforeEach(() => {
        db = createTestDb();
    });

    afterEach(() => {
        db.close();
    });

    it("treats absent, null, and old schemas without the document column as empty", () => {
        expect(getNativeReplayState(db, "missing")).toEqual({
            toolInputs: new Map(),
            reasoningIds: new Set(),
        });

        db.prepare(
            "INSERT INTO session_meta (session_id, trailing_blank_decisions) VALUES (?, NULL)",
        ).run("null-state");
        expect(getNativeReplayState(db, "null-state")).toEqual({
            toolInputs: new Map(),
            reasoningIds: new Set(),
        });

        const legacy = new Database(":memory:");
        try {
            legacy.exec("CREATE TABLE session_meta (session_id TEXT PRIMARY KEY)");
            legacy.prepare("INSERT INTO session_meta (session_id) VALUES (?)").run("legacy");

            expect(getNativeReplayState(legacy, "legacy")).toEqual({
                toolInputs: new Map(),
                reasoningIds: new Set(),
            });
            expect(getNativeToolInputs(legacy, "legacy")).toEqual(new Map());
            expect(getNativeReasoningIds(legacy, "legacy")).toEqual(new Set());
        } finally {
            legacy.close();
        }
    });

    it("uses an existing v84 store without adding obsolete native columns", () => {
        const directory = createTestTempDirFromPath(join(tmpdir(), "magic-context-v84-replay-"));
        const path = join(directory, "context.db");
        try {
            const seed = new Database(path);
            try {
                initializeDatabase(seed);
                runMigrations(seed);
                const version = seed
                    .prepare("SELECT MAX(version) AS version FROM schema_migrations")
                    .get() as { version: number };
                expect(version.version).toBe(LATEST_SUPPORTED_VERSION);
            } finally {
                seed.close();
            }

            const reopened = new Database(path);
            try {
                const before = (
                    reopened.prepare("PRAGMA table_info(session_meta)").all() as Array<{
                        name: string;
                    }>
                ).map((column) => column.name);
                initializeDatabase(reopened);
                const after = (
                    reopened.prepare("PRAGMA table_info(session_meta)").all() as Array<{
                        name: string;
                    }>
                ).map((column) => column.name);

                expect(after).toEqual(before);

                saveNativeToolInputs(
                    reopened,
                    "session",
                    new Map([["call-1", '{"path":"src/a.ts"}']]),
                );
                expect(getNativeToolInputs(reopened, "session")).toEqual(
                    new Map([["call-1", '{"path":"src/a.ts"}']]),
                );
            } finally {
                reopened.close();
            }
        } finally {
            rmSync(directory, { recursive: true, force: true });
        }
    });

    it("reads historical flat decisions and keeps byte-identical no-op documents flat", () => {
        const flat = '{"assistant-keep":"keep","assistant-strip":"strip"}';
        db.prepare(
            "INSERT INTO session_meta (session_id, trailing_blank_decisions) VALUES (?, ?)",
        ).run("flat", flat);

        expect(getTrailingBlankDecisions(db, "flat")).toEqual(
            new Map([
                ["assistant-keep", "keep"],
                ["assistant-strip", "strip"],
            ]),
        );
        expect(getNativeReplayState(db, "flat")).toEqual({
            toolInputs: new Map(),
            reasoningIds: new Set(),
        });

        expect(addTrailingBlankDecisions(db, "flat", [["assistant-keep", "keep"]])).toBe(true);
        expect(demoteTrailingBlankKeepDecisions(db, "flat", ["missing"])).toEqual([]);
        saveNativeToolInputs(db, "flat", new Map());
        addNativeReasoningIds(db, "flat", []);

        expect(replayDocumentRaw(db, "flat")).toBe(flat);
    });

    it("preserves blank decisions and native lanes across updates and demotions", () => {
        const initialInput = '{"path":"src/old.ts","marker":"[truncated]"}';
        const refreshedInput = '{"path":"src/old.ts","marker":"[full]"}';
        const secondInput = '{"path":"src/new.ts"}';

        expect(addTrailingBlankDecisions(db, "session", [["assistant-keep", "keep"]])).toBe(true);
        // A decision is a row of its own; the envelope column is not rewritten.
        expect(decisionRows(db, "session")).toEqual([
            { message_id: "assistant-keep", decision: "keep" },
        ]);
        expect(replayDocumentRaw(db, "session")).toBe("");

        saveNativeToolInputs(db, "session", new Map([["call-1", initialInput]]));
        addNativeReasoningIds(db, "session", ["assistant-1", "assistant-2"]);
        expect(addTrailingBlankDecisions(db, "session", [["assistant-later", "keep:2"]])).toBe(
            true,
        );
        expect(demoteTrailingBlankKeepDecisions(db, "session", ["assistant-keep"])).toEqual([
            "assistant-keep",
        ]);
        saveNativeToolInputs(
            db,
            "session",
            new Map([
                ["call-1", refreshedInput],
                ["call-2", secondInput],
            ]),
        );

        expect(getTrailingBlankDecisions(db, "session")).toEqual(
            new Map([
                ["assistant-keep", "strip"],
                ["assistant-later", "keep:2"],
            ]),
        );
        expect(getNativeReplayState(db, "session")).toEqual({
            toolInputs: new Map([
                ["call-1", refreshedInput],
                ["call-2", secondInput],
            ]),
            reasoningIds: new Set(["assistant-1", "assistant-2"]),
        });

        const stored = parseReplayDocument(replayDocumentRaw(db, "session"));
        expect(stored.version).toBe(2);
        expect(stored.piNative).toEqual({
            toolInputs: {
                "call-1": refreshedInput,
                "call-2": secondInput,
            },
            reasoningIds: ["assistant-1", "assistant-2"],
        });
    });

    it("keeps opaque v2 namespaces while a native writer changes its lanes", () => {
        const firstInput = '{"path":"src/first.ts"}';
        const nextInput = '{"path":"src/next.ts","mode":"exact"}';
        const stored = JSON.stringify({
            version: 2,
            trailingBlank: { "assistant-blank": "keep" },
            piNative: {
                toolInputs: { "call-1": firstInput },
                reasoningIds: ["assistant-1"],
                nativeExtension: { retained: true },
            },
            cloneExtension: { source: "future-writer" },
        });
        db.prepare(
            "INSERT INTO session_meta (session_id, trailing_blank_decisions) VALUES (?, ?)",
        ).run("opaque", stored);

        saveNativeToolInputs(db, "opaque", new Map([["call-2", nextInput]]));
        addNativeReasoningIds(db, "opaque", ["assistant-2"]);

        const document = parseReplayDocument(replayDocumentRaw(db, "opaque"));
        expect(document.trailingBlank).toEqual({ "assistant-blank": "keep" });
        expect(document.piNative).toEqual({
            toolInputs: {
                "call-1": firstInput,
                "call-2": nextInput,
            },
            reasoningIds: ["assistant-1", "assistant-2"],
            nativeExtension: { retained: true },
        });
        expect(document.cloneExtension).toEqual({ source: "future-writer" });
        expect(parseReplayDocument(serializeReplayDocument(document))).toEqual(document);
    });

    it("retries a stale blank update after a native update without losing either namespace", () => {
        expect(addTrailingBlankDecisions(db, "session", [["existing", "keep"]])).toBe(true);
        const restore = interleaveFirstReplayWrite(db, DECISION_WRITE_PREFIXES, () => {
            saveNativeToolInputs(db, "session", new Map([["call-1", '{"path":"src/native.ts"}']]));
        });
        try {
            expect(addTrailingBlankDecisions(db, "session", [["blank", "strip"]])).toBe(true);
        } finally {
            restore();
        }

        expect(getTrailingBlankDecisions(db, "session")).toEqual(
            new Map([
                ["existing", "keep"],
                ["blank", "strip"],
            ]),
        );
        expect(getNativeToolInputs(db, "session")).toEqual(
            new Map([["call-1", '{"path":"src/native.ts"}']]),
        );
    });

    it("retries a stale native update after a blank update without losing either namespace", () => {
        saveNativeToolInputs(db, "session", new Map([["call-existing", '{"path":"src/old.ts"}']]));
        const restore = interleaveFirstReplayWrite(db, [ENVELOPE_WRITE_PREFIX], () => {
            expect(addTrailingBlankDecisions(db, "session", [["blank", "keep"]])).toBe(true);
        });
        try {
            addNativeReasoningIds(db, "session", ["assistant-1"]);
        } finally {
            restore();
        }

        expect(getTrailingBlankDecisions(db, "session")).toEqual(new Map([["blank", "keep"]]));
        expect(getNativeReplayState(db, "session")).toEqual({
            toolInputs: new Map([["call-existing", '{"path":"src/old.ts"}']]),
            reasoningIds: new Set(["assistant-1"]),
        });
    });

    it("surfaces CAS exhaustion without claiming either writer family persisted", () => {
        expect(addTrailingBlankDecisions(db, "session", [["assistant-keep", "keep"]])).toBe(true);
        const before = replayDocumentRaw(db, "session");
        const rowsBefore = decisionRows(db, "session");
        const restore = exhaustReplayDocumentCas(db);
        try {
            expect(addTrailingBlankDecisions(db, "session", [["assistant-new", "strip"]])).toBe(
                false,
            );
            expect(demoteTrailingBlankKeepDecisions(db, "session", ["assistant-keep"])).toBeNull();
            expect(() =>
                saveNativeToolInputs(db, "session", new Map([["call-1", '{"path":"src/a.ts"}']])),
            ).toThrow("failed to persist native replay state");
            expect(() => addNativeReasoningIds(db, "session", ["assistant-1"])).toThrow(
                "failed to persist native replay state",
            );
        } finally {
            restore();
        }

        expect(replayDocumentRaw(db, "session")).toBe(before);
        expect(decisionRows(db, "session")).toEqual(rowsBefore);
    });

    it("fails closed on unknown envelopes and malformed native state without erasing stored data", () => {
        const unknown =
            '{"version":99,"trailingBlank":{"assistant":"keep"},"piNative":{"toolInputs":{},"reasoningIds":[]}}';
        db.prepare(
            "INSERT INTO session_meta (session_id, trailing_blank_decisions) VALUES (?, ?)",
        ).run("unknown", unknown);

        expect(getTrailingBlankDecisions(db, "unknown")).toEqual(new Map());
        expect(addTrailingBlankDecisions(db, "unknown", [["later", "strip"]])).toBe(false);
        expect(demoteTrailingBlankKeepDecisions(db, "unknown", ["assistant"])).toBeNull();
        expect(() => getNativeReplayState(db, "unknown")).toThrow("unknown envelope version");
        expect(() => saveNativeToolInputs(db, "unknown", new Map([["call", "{}"]]))).toThrow(
            "failed to persist native replay state",
        );
        expect(replayDocumentRaw(db, "unknown")).toBe(unknown);

        const malformed =
            '{"version":2,"trailingBlank":{"assistant":"keep"},"piNative":{"toolInputs":"{","reasoningIds":[]}}';
        db.prepare(
            "INSERT INTO session_meta (session_id, trailing_blank_decisions) VALUES (?, ?)",
        ).run("malformed", malformed);

        expect(getTrailingBlankDecisions(db, "malformed")).toEqual(
            new Map([["assistant", "keep"]]),
        );
        expect(() => getNativeReplayState(db, "malformed")).toThrow(
            "invalid persisted native tool inputs state",
        );
        expect(() => saveNativeToolInputs(db, "malformed", new Map([["call", "{}"]]))).toThrow(
            "invalid persisted native tool inputs state",
        );
        expect(replayDocumentRaw(db, "malformed")).toBe(malformed);
        expect(addTrailingBlankDecisions(db, "malformed", [["assistant", "keep"]])).toBe(true);
        expect(replayDocumentRaw(db, "malformed")).toBe(malformed);

        expect(addTrailingBlankDecisions(db, "malformed", [["later", "strip"]])).toBe(true);
        // The new decision is a row; the stored envelope stays byte-identical.
        expect(replayDocumentRaw(db, "malformed")).toBe(malformed);
        const afterBlankWrite = readReplayDocument(db, "malformed");
        expect(afterBlankWrite.trailingBlank).toEqual({
            assistant: "keep",
            later: "strip",
        });
        expect(afterBlankWrite.piNative).toEqual({ toolInputs: "{", reasoningIds: [] });
        const malformedReasoning =
            '{"version":2,"trailingBlank":{},"piNative":{"toolInputs":{"call":"{}"},"reasoningIds":[""]}}';
        db.prepare(
            "INSERT INTO session_meta (session_id, trailing_blank_decisions) VALUES (?, ?)",
        ).run("malformed-reasoning", malformedReasoning);
        expect(() => getNativeToolInputs(db, "malformed-reasoning")).toThrow(
            "invalid persisted native reasoning ids state",
        );
    });

    it("replays exact tool bytes and reasoning ids after reopening the database", () => {
        const directory = createTestTempDirFromPath(join(tmpdir(), "magic-context-native-replay-"));
        const path = join(directory, "context.db");
        const input = '{"path":"src/reopened.ts","range":{"start":1,"end":9}}';
        try {
            const writer = new Database(path);
            try {
                initializeDatabase(writer);
                runMigrations(writer);
                saveNativeToolInputs(writer, "session", new Map([["call-1", input]]));
                addNativeReasoningIds(writer, "session", ["assistant-1"]);
            } finally {
                writer.close();
            }

            const reader = new Database(path);
            try {
                expect(getNativeReplayState(reader, "session")).toEqual({
                    toolInputs: new Map([["call-1", input]]),
                    reasoningIds: new Set(["assistant-1"]),
                });
                expect(parseReplayDocument(replayDocumentRaw(reader, "session")).piNative).toEqual({
                    toolInputs: { "call-1": input },
                    reasoningIds: ["assistant-1"],
                });
            } finally {
                reader.close();
            }
        } finally {
            rmSync(directory, { recursive: true, force: true });
        }
    });

    it("rolls back a failed whole-document write without changing either durable lane", () => {
        const firstInput = '{"path":"src/first.ts"}';
        saveNativeToolInputs(db, "session", new Map([["call-1", firstInput]]));
        addNativeReasoningIds(db, "session", ["assistant-1"]);
        const before = replayDocumentRaw(db, "session");
        db.exec(`
            CREATE TRIGGER fail_native_replay_update
            BEFORE UPDATE OF trailing_blank_decisions ON session_meta
            WHEN NEW.session_id = 'session'
            BEGIN
                SELECT RAISE(ABORT, 'injected native replay write failure');
            END;
        `);

        expect(() =>
            saveNativeToolInputs(db, "session", new Map([["call-2", '{"path":"src/second.ts"}']])),
        ).toThrow("injected native replay write failure");
        expect(() => addNativeReasoningIds(db, "session", ["assistant-2"])).toThrow(
            "injected native replay write failure",
        );

        expect(replayDocumentRaw(db, "session")).toBe(before);
        expect(getNativeReplayState(db, "session")).toEqual({
            toolInputs: new Map([["call-1", firstInput]]),
            reasoningIds: new Set(["assistant-1"]),
        });
    });
});
