import { expect, it } from "bun:test";
import { createEventHandler } from "../../hooks/magic-context/event-handler";
import { saveLkgSlotToDb } from "../../hooks/magic-context/lkg-persist";
import { readServedTemporalDecisions } from "../../hooks/magic-context/temporal-served-projection";
import { Database } from "../../shared/sqlite";
import { runMigrations } from "./migrations";
import { getOrCreateSessionMeta, insertTag } from "./storage";
import { initializeDatabase } from "./storage-db";
import { addMergedReasoningStrippedIds } from "./storage-meta-persisted";
import { deleteSessionScopedRows } from "./storage-session-tables";
import { replaceSourceContent } from "./storage-source";
import { createTagger } from "./tagger";
import {
    freezeTemporalDecisions,
    getTemporalDecisions,
    observeTemporalDecisions,
} from "./temporal-decisions";

it("temporal choices freeze absence as well as marker bytes and preserve other replay entries", () => {
    const db = new Database(":memory:");
    initializeDatabase(db);
    runMigrations(db);
    try {
        addMergedReasoningStrippedIds(db, "session", ["assistant"]);
        freezeTemporalDecisions(
            db,
            "session",
            new Map([
                ["none", ""],
                ["gap", "<!-- +5m -->\n"],
            ]),
        );
        const replay = freezeTemporalDecisions(
            db,
            "session",
            new Map([
                ["none", "<!-- +2h -->\n"],
                ["gap", ""],
            ]),
        );
        // Callers render the returned snapshot, not a second read of the ledger.
        expect(replay).toEqual(
            new Map([
                ["none", ""],
                ["gap", "<!-- +5m -->\n"],
            ]),
        );
        expect(getTemporalDecisions(db, "session")).toEqual(
            new Map([
                ["none", ""],
                ["gap", "<!-- +5m -->\n"],
            ]),
        );
        expect(
            observeTemporalDecisions(db, "session", new Map(), undefined, ["gap"]).get("gap"),
        ).toBe("<!-- +5m -->\n");
        const row = db
            .prepare(
                "SELECT merged_reasoning_stripped_ids AS entries FROM session_meta WHERE session_id = 'session'",
            )
            .get() as { entries: string };
        expect(JSON.parse(row.entries)).toContain("assistant");
        db.exec(
            "CREATE TRIGGER refuse_temporal BEFORE INSERT ON temporal_decisions BEGIN SELECT RAISE(FAIL, 'refused temporal freeze'); END",
        );
        expect(() =>
            freezeTemporalDecisions(db, "session", new Map([["new", "<!-- +1h -->\n"]])),
        ).toThrow("refused temporal freeze");
        expect(getTemporalDecisions(db, "session").has("new")).toBe(false);
    } finally {
        db.close();
    }
});

it("new deferred messages stay pending across repeated passes until a rebuilding decision", () => {
    const db = new Database(":memory:");
    initializeDatabase(db);
    runMigrations(db);
    try {
        const candidates = new Map([["new", "<!-- +5m -->\n"]]);
        expect(observeTemporalDecisions(db, "s", candidates).size).toBe(0);
        insertTag(db, "s", "new:p0", "message", 1, 1);
        expect(observeTemporalDecisions(db, "s", candidates).size).toBe(0);
        expect(
            db
                .prepare(
                    "SELECT marker FROM temporal_decisions WHERE session_id='s' AND message_id='new'",
                )
                .get(),
        ).toEqual({ marker: null });
        expect(freezeTemporalDecisions(db, "s", candidates).get("new")).toBe("<!-- +5m -->\n");
        expect(observeTemporalDecisions(db, "s", new Map([["new", ""]])).get("new")).toBe(
            "<!-- +5m -->\n",
        );
    } finally {
        db.close();
    }
});

it("legacy adoption prefers an exact served choice over a changed predecessor", () => {
    const db = new Database(":memory:");
    initializeDatabase(db);
    runMigrations(db);
    try {
        insertTag(db, "s", "user:p0", "message", 1, 1);
        const adopted = observeTemporalDecisions(
            db,
            "s",
            new Map([["user", ""]]),
            () => new Map([["user", "<!-- +5m -->\n"]]),
        );
        expect(adopted.get("user")).toBe("<!-- +5m -->\n");
        expect(
            observeTemporalDecisions(db, "s", new Map([["user", "<!-- +2h -->\n"]])).get("user"),
        ).toBe("<!-- +5m -->\n");
    } finally {
        db.close();
    }
});

it("a legacy served-none projection holds a newly discoverable marker until rebuild", () => {
    const db = new Database(":memory:");
    initializeDatabase(db);
    runMigrations(db);
    try {
        insertTag(db, "s", "user:p0", "message", 1, 1);
        const candidate = new Map([["user", "<!-- +5m -->\n"]]);
        expect(
            observeTemporalDecisions(db, "s", candidate, () => new Map([["user", ""]])).size,
        ).toBe(0);
        expect(observeTemporalDecisions(db, "s", candidate).size).toBe(0);
        expect(freezeTemporalDecisions(db, "s", candidate).get("user")).toBe("<!-- +5m -->\n");
    } finally {
        db.close();
    }
});

it("Pi adopts a persisted pre-ownership LKG marker at a changed cut seam", () => {
    const db = new Database(":memory:");
    initializeDatabase(db);
    runMigrations(db);
    try {
        insertTag(db, "legacy-lkg", "user:p0", "message", 1, 7);
        expect(
            saveLkgSlotToDb(db, "legacy-lkg", {
                jsonPrefix: JSON.stringify([
                    { role: "user", content: "§7§ <!-- +5m -->\nquestion" },
                ]),
                inputIdSeq: ["user"],
                inputContentDigests: ["digest"],
                lastInputMessageId: "user",
                modelKey: "mock/model",
                providerKey: "mock",
                capturedAt: Date.now(),
            }),
        ).toBe(true);
        const served = readServedTemporalDecisions(db, "legacy-lkg", "pi");
        expect(served.get("user")).toBe("<!-- +5m -->\n");
        expect(
            observeTemporalDecisions(db, "legacy-lkg", new Map([["user", ""]]), () => served).get(
                "user",
            ),
        ).toBe("<!-- +5m -->\n");
        replaceSourceContent(db, "legacy-lkg", 7, "<!-- +17m -->\nquestion");
        expect(readServedTemporalDecisions(db, "legacy-lkg", "pi", ["user"]).get("user")).toBe(
            "<!-- +5m -->\n",
        );
    } finally {
        db.close();
    }
});

it("unproven legacy candidates render transiently but never freeze before a rebuilding pass", () => {
    const db = new Database(":memory:");
    initializeDatabase(db);
    runMigrations(db);
    try {
        insertTag(db, "unproven", "user:p0", "message", 1, 1);
        const evidence = (ids: Iterable<string>) =>
            readServedTemporalDecisions(db, "unproven", "pi", ids);
        expect(
            observeTemporalDecisions(
                db,
                "unproven",
                new Map([["user", "<!-- +5m -->\n"]]),
                evidence,
            ).get("user"),
        ).toBe("<!-- +5m -->\n");
        expect(getTemporalDecisions(db, "unproven").size).toBe(0);
        expect(
            observeTemporalDecisions(
                db,
                "unproven",
                new Map([["user", "<!-- +10m -->\n"]]),
                evidence,
            ).get("user"),
        ).toBe("<!-- +10m -->\n");
        expect(getTemporalDecisions(db, "unproven").size).toBe(0);
        expect(
            freezeTemporalDecisions(db, "unproven", new Map([["user", "<!-- +12m -->\n"]])).get(
                "user",
            ),
        ).toBe("<!-- +12m -->\n");
        expect(
            observeTemporalDecisions(db, "unproven", new Map([["user", ""]]), evidence).get("user"),
        ).toBe("<!-- +12m -->\n");
    } finally {
        db.close();
    }
});

it("a missing first text source is not replaced by a later part's marker evidence", () => {
    const db = new Database(":memory:");
    initializeDatabase(db);
    runMigrations(db);
    try {
        insertTag(db, "first-source", "user:p1", "message", 1, 1);
        insertTag(db, "first-source", "user:p0", "message", 1, 2);
        replaceSourceContent(db, "first-source", 1, "later text has no marker");
        expect(readServedTemporalDecisions(db, "first-source", "pi", ["user"]).has("user")).toBe(
            false,
        );
        replaceSourceContent(db, "first-source", 2, "<!-- +5m -->\nfirst text");
        expect(readServedTemporalDecisions(db, "first-source", "pi", ["user"]).get("user")).toBe(
            "<!-- +5m -->\n",
        );
    } finally {
        db.close();
    }
});

it("message.removed prunes the removed temporal identity but preserves surviving choices", async () => {
    const db = new Database(":memory:");
    initializeDatabase(db);
    runMigrations(db);
    try {
        getOrCreateSessionMeta(db, "removed-session");
        insertTag(db, "removed-session", "removed:p0", "message", 1, 1);
        insertTag(db, "removed-session", "kept:p0", "message", 1, 2);
        freezeTemporalDecisions(
            db,
            "removed-session",
            new Map([
                ["removed", "<!-- +5m -->\n"],
                ["kept", ""],
            ]),
        );
        const handler = createEventHandler({
            db,
            contextUsageMap: new Map(),
            compactionHandler: { onCompacted: () => {} } as never,
            config: { cache_ttl: "5m" },
            tagger: createTagger(),
            client: {} as never,
        });
        await handler({
            event: {
                type: "message.removed",
                properties: { sessionID: "removed-session", messageID: "removed" },
            },
        });
        expect(getTemporalDecisions(db, "removed-session")).toEqual(new Map([["kept", ""]]));
        getOrCreateSessionMeta(db, "another-session");
        freezeTemporalDecisions(db, "another-session", new Map([["kept", "<!-- +1h -->\n"]]));
        deleteSessionScopedRows(db, ["removed-session"]);
        expect(getTemporalDecisions(db, "removed-session").size).toBe(0);
        expect(getTemporalDecisions(db, "another-session").get("kept")).toBe("<!-- +1h -->\n");
    } finally {
        db.close();
    }
});
