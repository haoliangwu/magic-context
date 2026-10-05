/// <reference types="bun-types" />

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Database } from "../../shared/sqlite";
import { runMigrations } from "./migrations";
import { initializeDatabase } from "./storage-db";
import {
    addMergedReasoningStrippedIds,
    addTrailingBlankDecisions,
    demoteTrailingBlankKeepDecisions,
    getMergedReasoningStrippedIds,
    getTrailingBlankDecisions,
} from "./storage-meta-persisted";
import { clearSession } from "./storage-meta-session";
import { readReplayDocument } from "./storage-replay-document";

describe("merged_reasoning_stripped_ids", () => {
    let db: Database;
    const sessionId = "ses-merged-reasoning";

    beforeEach(() => {
        db = new Database(":memory:");
        initializeDatabase(db);
        runMigrations(db);
    });

    afterEach(() => {
        db.close();
    });

    it("persists a monotonic union of assistant message ids", () => {
        expect(getMergedReasoningStrippedIds(db, sessionId)).toEqual(new Set());

        expect(addMergedReasoningStrippedIds(db, sessionId, ["assistant-1"])).toBe(true);
        expect(addMergedReasoningStrippedIds(db, sessionId, ["assistant-1", "assistant-2"])).toBe(
            true,
        );

        expect(getMergedReasoningStrippedIds(db, sessionId)).toEqual(
            new Set(["assistant-1", "assistant-2"]),
        );
    });

    it("keeps the first committed exact-part decision when a stale writer proposes another", () => {
        const winner = '__merged_reasoning_parts_v1__:["assistant-1",["part-2"]]';
        const loser = '__merged_reasoning_parts_v1__:["assistant-1",["part-1","part-2"]]';
        expect(addMergedReasoningStrippedIds(db, sessionId, ["assistant-1", winner])).toBe(true);
        expect(
            addMergedReasoningStrippedIds(db, sessionId, ["assistant-1", loser, "assistant-2"]),
        ).toBe(true);
        expect(getMergedReasoningStrippedIds(db, sessionId)).toEqual(
            new Set(["assistant-1", winner, "assistant-2"]),
        );
    });

    it("removes the applied set when the session is cleared", () => {
        addMergedReasoningStrippedIds(db, sessionId, ["assistant-1"]);
        expect(getMergedReasoningStrippedIds(db, sessionId)).toEqual(new Set(["assistant-1"]));

        clearSession(db, sessionId);

        expect(getMergedReasoningStrippedIds(db, sessionId)).toEqual(new Set());
        expect(
            db.prepare("SELECT 1 FROM session_meta WHERE session_id = ?").get(sessionId),
        ).toBeNull();
    });
});

describe("trailing_blank_decisions", () => {
    let db: Database;
    const sessionId = "ses-trailing-blank";

    beforeEach(() => {
        db = new Database(":memory:");
        initializeDatabase(db);
        runMigrations(db);
    });

    afterEach(() => {
        db.close();
    });

    it("persists immutable keep and strip choices", () => {
        expect(getTrailingBlankDecisions(db, sessionId)).toEqual(new Map());
        expect(
            addTrailingBlankDecisions(db, sessionId, [
                ["assistant-keep", "keep"],
                ["assistant-strip", "strip"],
            ]),
        ).toBe(true);
        expect(addTrailingBlankDecisions(db, sessionId, [["assistant-keep", "strip"]])).toBe(true);

        expect(getTrailingBlankDecisions(db, sessionId)).toEqual(
            new Map([
                ["assistant-keep", "keep"],
                ["assistant-strip", "strip"],
            ]),
        );
    });

    it("refreshes a live keep without reopening an absorbing strip", () => {
        addTrailingBlankDecisions(db, sessionId, [
            ["assistant-historical", "strip"],
            ["assistant-newest-strip", "strip"],
            ["assistant-newest-keep", "keep"],
        ]);

        expect(
            addTrailingBlankDecisions(
                db,
                sessionId,
                [
                    ["assistant-historical", "keep"],
                    ["assistant-newest-strip", "keep"],
                ],
                { overwriteMessageId: "assistant-newest-strip" },
            ),
        ).toBe(true);
        expect(
            addTrailingBlankDecisions(db, sessionId, [["assistant-newest-keep", "keep:3"]], {
                overwriteMessageId: "assistant-newest-keep",
            }),
        ).toBe(true);
        expect(getTrailingBlankDecisions(db, sessionId)).toEqual(
            new Map([
                ["assistant-historical", "strip"],
                ["assistant-newest-strip", "strip"],
                ["assistant-newest-keep", "keep:3"],
            ]),
        );
    });

    it("demotes only frozen keep decisions selected for healing", () => {
        addTrailingBlankDecisions(db, sessionId, [
            ["assistant-keep", "keep"],
            ["assistant-keep-two", "keep:2"],
            ["assistant-strip", "strip"],
        ]);

        expect(
            demoteTrailingBlankKeepDecisions(db, sessionId, [
                "assistant-keep",
                "assistant-keep-two",
                "assistant-strip",
                "assistant-missing",
            ]),
        ).toEqual(["assistant-keep", "assistant-keep-two"]);
        expect(getTrailingBlankDecisions(db, sessionId)).toEqual(
            new Map([
                ["assistant-keep", "strip"],
                ["assistant-keep-two", "strip"],
                ["assistant-strip", "strip"],
            ]),
        );
    });

    it("mutates only trailingBlank while preserving native and opaque v2 namespaces", () => {
        const nativeInput = '{"path":"src/frozen.ts","range":{"start":2,"end":4}}';
        const stored = JSON.stringify({
            version: 2,
            trailingBlank: {
                "assistant-keep": "keep",
            },
            piNative: {
                toolInputs: {
                    "call-1": nativeInput,
                },
                reasoningIds: ["entry-1"],
                nativeExtension: { retain: true },
            },
            otherNamespace: { retained: ["one", "two"] },
        });
        db.prepare(
            "INSERT INTO session_meta (session_id, trailing_blank_decisions) VALUES (?, ?)",
        ).run(sessionId, stored);

        expect(addTrailingBlankDecisions(db, sessionId, [["assistant-new", "keep:2"]])).toBe(true);
        expect(demoteTrailingBlankKeepDecisions(db, sessionId, ["assistant-keep"])).toEqual([
            "assistant-keep",
        ]);

        // The decisions are stored as rows and the namespaces in the column, so
        // the stored document is read through the API that joins them.
        const document = readReplayDocument(db, sessionId);
        expect(document.trailingBlank).toEqual({
            "assistant-keep": "strip",
            "assistant-new": "keep:2",
        });
        expect(document.piNative).toEqual({
            toolInputs: { "call-1": nativeInput },
            reasoningIds: ["entry-1"],
            nativeExtension: { retain: true },
        });
        expect(document.otherNamespace).toEqual({ retained: ["one", "two"] });
    });

    it("serves no decisions and refuses to overwrite an unsupported envelope", () => {
        const stored =
            '{"version":7,"trailingBlank":{"assistant-keep":"keep"},"futureNamespace":{"v":1}}';
        db.prepare(
            "INSERT INTO session_meta (session_id, trailing_blank_decisions) VALUES (?, ?)",
        ).run(sessionId, stored);

        expect(getTrailingBlankDecisions(db, sessionId)).toEqual(new Map());
        expect(addTrailingBlankDecisions(db, sessionId, [["assistant-new", "strip"]])).toBe(false);
        expect(demoteTrailingBlankKeepDecisions(db, sessionId, ["assistant-keep"])).toBeNull();
        const row = db
            .prepare("SELECT trailing_blank_decisions FROM session_meta WHERE session_id = ?")
            .get(sessionId) as { trailing_blank_decisions: string } | undefined;
        expect(row?.trailing_blank_decisions).toBe(stored);
    });

    it("preserves arbitrary historical ids rather than treating them as object metadata", () => {
        expect(
            addTrailingBlankDecisions(db, sessionId, [
                ["version", "keep"],
                ["constructor", "keep:2"],
                ["__proto__", "strip"],
            ]),
        ).toBe(true);
        expect(getTrailingBlankDecisions(db, sessionId)).toEqual(
            new Map([
                ["version", "keep"],
                ["constructor", "keep:2"],
                ["__proto__", "strip"],
            ]),
        );
        expect(
            demoteTrailingBlankKeepDecisions(db, sessionId, ["constructor", "toString"]),
        ).toEqual(["constructor"]);
        expect(getTrailingBlankDecisions(db, sessionId).get("__proto__")).toBe("strip");
        expect(getTrailingBlankDecisions(db, sessionId).get("constructor")).toBe("strip");
    });

    it("retains valid legacy decisions on reads without overwriting malformed stored entries", () => {
        const stored = '{"assistant-keep":"keep","invalid-entry":42}';
        db.prepare(
            "INSERT INTO session_meta (session_id, trailing_blank_decisions) VALUES (?, ?)",
        ).run(sessionId, stored);
        expect(getTrailingBlankDecisions(db, sessionId)).toEqual(
            new Map([["assistant-keep", "keep"]]),
        );
        expect(addTrailingBlankDecisions(db, sessionId, [["assistant-new", "strip"]])).toBe(false);
        expect(
            db
                .prepare("SELECT trailing_blank_decisions FROM session_meta WHERE session_id = ?")
                .get(sessionId),
        ).toEqual({ trailing_blank_decisions: stored });
    });

    it("removes decisions when the session is cleared", () => {
        addTrailingBlankDecisions(db, sessionId, [["assistant-keep", "keep"]]);
        clearSession(db, sessionId);
        expect(getTrailingBlankDecisions(db, sessionId)).toEqual(new Map());
    });
});
