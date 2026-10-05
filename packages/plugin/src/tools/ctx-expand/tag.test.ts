import { describe, expect, it } from "bun:test";
import { runMigrations } from "../../features/magic-context/migrations";
import { parseRangeString } from "../../features/magic-context/range-parser";
import { initializeDatabase } from "../../features/magic-context/storage-db";
import { createTagger } from "../../features/magic-context/tagger";
import { setRawMessageProvider } from "../../hooks/magic-context/read-session-chunk";
import { Database } from "../../shared/sqlite";
import { resolveCtxExpandMode } from "./mode";
import { createCtxExpandTools } from "./tools";

const forms = [12, "12", "§12§", "§12", "tag 12", "[dropped §12§]", "  §12§  "];
describe("ctx_expand tag input", () => {
    for (const tag of forms)
        it(`normalizes ${JSON.stringify(tag)}`, () => {
            expect(resolveCtxExpandMode({ tag }, "positive")).toEqual({ kind: "tag", tag: 12 });
        });
    for (const tag of [0, -1, 1.5, "", "12 13", "§§12§", "tag 12 extra", "[dropped §12§] extra"])
        it(`refuses ${JSON.stringify(tag)}`, () => {
            expect(resolveCtxExpandMode({ tag }, "positive")).toMatchObject({ kind: "error" });
        });
    it("accepts copied tag forms in reduction lists and ranges", () => {
        expect(parseRangeString("§3§-§5§")).toEqual([3, 4, 5]);
        expect(parseRangeString("§1§,§9§")).toEqual([1, 9]);
        expect(parseRangeString("tag 1,[dropped §9§],§12")).toEqual([1, 9, 12]);
    });
    it("recovers text, one tool, and the right dropped sibling without confusing tag 4 with ordinal 4", async () => {
        const db = new Database(":memory:");
        initializeDatabase(db);
        runMigrations(db);
        const sessionId = "tag-recovery";
        const tagger = createTagger();
        const tool = (callID: string, output: string) => ({
            type: "tool",
            tool: "read",
            callID,
            state: { input: { path: `${callID}.txt` }, output },
        });
        const cleanup = setRawMessageProvider(sessionId, {
            readMessages: () => [
                {
                    ordinal: 1,
                    id: "one",
                    role: "user",
                    parts: [{ type: "step-start" }, { type: "text", text: "original text" }],
                },
                {
                    ordinal: 2,
                    id: "two",
                    role: "assistant",
                    parts: [tool("single", "single output")],
                },
                {
                    ordinal: 3,
                    id: "three",
                    role: "assistant",
                    parts: [tool("left", "left output"), tool("right", "right output")],
                },
                {
                    ordinal: 4,
                    id: "four",
                    role: "user",
                    parts: [{ type: "text", text: "ordinal four, not tag four" }],
                },
            ],
        });
        try {
            expect(tagger.assignTag(sessionId, "one:p1", "message", 10, db)).toBe(1);
            tagger.assignToolTag(sessionId, "single", "two", 10, db);
            tagger.assignToolTag(sessionId, "left", "three", 10, db);
            expect(tagger.assignToolTag(sessionId, "right", "three", 10, db)).toBe(4);
            db.prepare(
                "UPDATE tags SET status = 'dropped' WHERE session_id = ? AND tag_number = 4",
            ).run(sessionId);
            const expand = createCtxExpandTools({ db }).ctx_expand;
            const ctx = { sessionID: sessionId } as never;
            expect(await expand.execute({ tag: 1 }, ctx)).toContain("original text");
            const single = await expand.execute({ tag: 2 }, ctx);
            expect(single).toContain("single.txt");
            expect(single).toContain("single output");
            const right = await expand.execute({ tag: "[dropped §4§]" }, ctx);
            expect(right).toContain("right.txt");
            expect(right).toContain("right output");
            expect(right).not.toContain("left output");
            expect(right).not.toContain("ordinal four");
            expect(await expand.execute({ message: 4 }, ctx)).toContain(
                "ordinal four, not tag four",
            );
            expect(await expand.execute({ message: 3 }, ctx)).toContain("left output");
            expect(await expand.execute({ tag: 99 }, ctx)).toBe(
                "no tag 99 in this session; if 99 came from a <session-history> heading or a ctx_search hit, it is an ordinal: use message=99",
            );
        } finally {
            cleanup();
            db.close();
        }
    });
});
