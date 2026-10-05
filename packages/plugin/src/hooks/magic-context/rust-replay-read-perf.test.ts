/// <reference types="bun-types" />
import { describe, expect, it, spyOn } from "bun:test";
import { initializeDatabase } from "../../features/magic-context/storage-db";
import { getOrCreateSessionMeta } from "../../features/magic-context/storage-meta";
import { getTrailingBlankDecisions } from "../../features/magic-context/storage-meta-persisted";
import { createTagger } from "../../features/magic-context/tagger";
import { Database } from "../../shared/sqlite";
import type { MessageLike } from "./transform-operations";
import { runRustModePostprocess } from "./transform-postprocess-phase";

function withDb(run: (db: Database) => void) {
    const db = new Database(":memory:");
    try {
        initializeDatabase(db);
        getOrCreateSessionMeta(db, "replay");
        run(db);
    } finally {
        db.close();
    }
}

function setDocument(db: Database, raw: string) {
    db.prepare(
        "UPDATE session_meta SET trailing_blank_decisions = ? WHERE session_id = 'replay'",
    ).run(raw);
}

function postprocess(db: Database): MessageLike[] {
    const messages: MessageLike[] = [
        {
            info: { id: "visible", role: "assistant", sessionID: "replay" },
            parts: [
                { type: "text", text: "answer" },
                { type: "text", text: "" },
            ],
        },
    ];
    runRustModePostprocess({
        db,
        sessionId: "replay",
        messages,
        fullFeatureMode: true,
        resolvedProviderID: "anthropic",
        tagger: createTagger(),
        ctxReduceAvailability: { callable: false, frozen: true },
    });
    return messages;
}

describe("Rust visible replay choices", () => {
    it("does not parse or enumerate archived decisions on four unchanged adapter passes", () => {
        withDb((db) => {
            const raw = JSON.stringify({
                ...Object.fromEntries(
                    Array.from({ length: 40_000 }, (_, i) => [`archived_${i}`, "strip"]),
                ),
                visible: "strip",
            });
            setDocument(db, raw);
            const first = postprocess(db);
            expect(first[0].parts).toEqual([{ type: "text", text: "answer" }]);
            const parse = JSON.parse;
            let parses = 0;
            const probe = spyOn(JSON, "parse").mockImplementation((text, reviver) => {
                if (text === raw) parses++;
                return parse(text, reviver);
            });
            const entries = Object.entries;
            let historicalEnumerations = 0;
            const enumeration = spyOn(Object, "entries").mockImplementation((value: object) => {
                if (Object.hasOwn(value, "archived_39999")) historicalEnumerations++;
                return entries(value);
            });
            try {
                for (let pass = 0; pass < 4; pass++) expect(postprocess(db)).toEqual(first);
                expect(parses).toBe(0);
                expect(historicalEnumerations).toBe(0);
            } finally {
                probe.mockRestore();
                enumeration.mockRestore();
            }
        });
    });

    it("observes changed, rolled-back, malformed and restored documents without leaking mutable maps", () => {
        withDb((db) => {
            setDocument(db, '{"visible":"keep","version":"strip","__proto__":"strip"}');
            const selected = getTrailingBlankDecisions(db, "replay", [
                "visible",
                "version",
                "__proto__",
                "missing",
            ]);
            expect([...selected]).toEqual([
                ["visible", "keep"],
                ["version", "strip"],
                ["__proto__", "strip"],
            ]);
            selected.set("visible", "strip");
            expect(getTrailingBlankDecisions(db, "replay", ["visible"]).get("visible")).toBe(
                "keep",
            );
            db.exec("BEGIN");
            setDocument(
                db,
                '{"version":2,"trailingBlank":{"visible":"strip"},"piNative":{"opaque":true}}',
            );
            expect(postprocess(db)[0].parts).toHaveLength(1);
            db.exec("ROLLBACK");
            expect(postprocess(db)[0].parts).toHaveLength(2);
            setDocument(db, "not json");
            expect(getTrailingBlankDecisions(db, "replay", ["visible"]).size).toBe(0);
            setDocument(db, '{"version":2,"trailingBlank":{"visible":"strip"}}');
            expect(postprocess(db)[0].parts).toHaveLength(1);
        });
    });
});
