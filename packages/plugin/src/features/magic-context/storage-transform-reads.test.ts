import { afterEach, expect, it, spyOn } from "bun:test";
import { Database } from "../../shared/sqlite";
import { readFrozenMergedReasoningParts } from "./merged-reasoning-decisions";
import { initializeDatabase } from "./storage-db";
import { getSourceContents, replaceSourceContent, saveSourceContent } from "./storage-source";
import {
    getActiveTagTokenTotalsByMessage,
    getDroppedTagsByNumbers,
    getInertWhitespaceAssistantTags,
    getInertWhitespaceAssistantTagsByNumbers,
    getTagById,
    getTagNumberByMessageId,
    insertTag,
    markWhitespaceAssistantTagInert,
    updateTagStatus,
} from "./storage-tags";

const databases: Database[] = [];
afterEach(() => {
    for (const db of databases.splice(0)) db.close();
});
function database() {
    const db = new Database(":memory:");
    databases.push(db);
    initializeDatabase(db);
    return db;
}

it("scopes token totals to exact missing owners without losing old tool or content-derived tags", () => {
    const db = database();
    const ids = ["a", "a:b", "a_%", "legacy-call"];
    const contentIds = [
        "a:p0",
        "a:file1",
        "a:mc-text-v1:abcd:0123:o1",
        "a:invalid-suffix",
        "a:b:p0",
        "a_%:p0",
        "legacy-call",
        "tool-call",
    ];
    contentIds.forEach((id, index) => {
        insertTag(db, "totals", id, index >= 6 ? "tool" : "message", 1, index + 1);
    });
    db.prepare(
        "UPDATE tags SET token_count = tag_number, input_token_count = 2, reasoning_token_count = 3 WHERE session_id = ?",
    ).run("totals");
    db.prepare("UPDATE tags SET tool_owner_message_id = 'a' WHERE message_id = 'tool-call'").run();
    db.prepare("UPDATE tags SET token_count = NULL WHERE message_id = 'a:b:p0'").run();
    const all = getActiveTagTokenTotalsByMessage(db, "totals");
    const expected = new Map([...all].filter(([id]) => ids.includes(id)));
    expect(getActiveTagTokenTotalsByMessage(db, "totals", [...ids, "a"])).toEqual(expected);
    expect(getActiveTagTokenTotalsByMessage(db, "totals", ["a"]).get("a")).toEqual(all.get("a"));
    expect(getActiveTagTokenTotalsByMessage(db, "totals", [])).toEqual(new Map());
    updateTagStatus(db, "totals", 8, "dropped");
    expect(getActiveTagTokenTotalsByMessage(db, "totals", ["a"]).get("a")?.toolCall).toBe(0);
    expect(getActiveTagTokenTotalsByMessage(db, "other", ids).size).toBe(0);
});

it("reads large source-id sets with one reusable statement and no stale content", () => {
    const db = database();
    saveSourceContent(db, "source", 1, "first");
    saveSourceContent(db, "source", 2, "second");
    saveSourceContent(db, "other", 1, "unrelated");
    const prepare = spyOn(db, "prepare");
    try {
        expect(getSourceContents(db, "source", [2, 1, 1])).toEqual(
            new Map([
                [1, "first"],
                [2, "second"],
            ]),
        );
        expect(
            getSourceContents(
                db,
                "source",
                Array.from({ length: 60_000 }, (_, i) => i + 1),
            ).size,
        ).toBe(2);
        expect(prepare).toHaveBeenCalledTimes(1);
    } finally {
        prepare.mockRestore();
    }
    replaceSourceContent(db, "source", 1, "edited");
    expect(getSourceContents(db, "source", [1]).get(1)).toBe("edited");
    expect(getSourceContents(db, "source", [])).toEqual(new Map());
});

it("batches exact inert owners, including wildcard characters and duplicate ids", () => {
    const db = database();
    insertTag(db, "inert", "a_%:p2", "message", 1, 1);
    insertTag(db, "inert", "a_%:p10", "message", 1, 2);
    insertTag(db, "inert", "a_%extra:p0", "message", 1, 3);
    markWhitespaceAssistantTagInert(db, "inert", 1, "a_%:p2");
    markWhitespaceAssistantTagInert(db, "inert", 2, "a_%:p10");
    markWhitespaceAssistantTagInert(db, "inert", 3, "a_%extra:p0");
    expect(getInertWhitespaceAssistantTags(db, "inert", ["a_%", "missing", "a_%"])).toEqual([
        { tagNumber: 2, contentId: "a_%:p10" },
        { tagNumber: 1, contentId: "a_%:p2" },
    ]);
    expect(getInertWhitespaceAssistantTags(db, "inert", [])).toEqual([]);
    expect(getInertWhitespaceAssistantTags(db, "other", ["a_%"])).toEqual([]);
});

it("looks up inert tags by number with exactly the unscoped read's answer", () => {
    const db = database();
    // Live, retired, non-message, empty-content and other-session rows around
    // the inert ones, so every predicate of the unscoped read is exercised.
    for (let tag = 1; tag <= 40; tag += 1) {
        insertTag(db, "by-number", `m${tag}:p0`, tag % 4 === 0 ? "tool" : "message", 1, tag);
        insertTag(db, "other", `m${tag}:p0`, "message", 1, tag);
    }
    for (const tag of [3, 7, 11, 13, 22, 29])
        markWhitespaceAssistantTagInert(db, "by-number", tag, `m${tag}:p1`);
    // Tag 8 is a tool tag; marking only updates message tags, so it stays out.
    markWhitespaceAssistantTagInert(db, "by-number", 8, "m8:p1");
    markWhitespaceAssistantTagInert(db, "by-number", 17, ""); // empty content id
    markWhitespaceAssistantTagInert(db, "other", 5, "m5:p1");
    db.prepare(
        "UPDATE tags SET status = 'active' WHERE session_id = 'by-number' AND tag_number = 29",
    ).run();
    db.prepare(
        "UPDATE tags SET status = 'compacted', entry_fingerprint = 'fp:other' WHERE session_id = 'by-number' AND tag_number = 30",
    ).run();
    // LIKE matches the prefix case-insensitively; the per-number read keeps that.
    db.prepare(
        "UPDATE tags SET status = 'compacted', entry_fingerprint = 'MC:WHITESPACE-ASSISTANT:m31:p1' WHERE session_id = 'by-number' AND tag_number = 31",
    ).run();

    const all = getInertWhitespaceAssistantTags(db, "by-number");
    expect(all.map((tag) => tag.tagNumber).sort((a, b) => a - b)).toEqual([3, 7, 11, 13, 22, 31]);
    const requested = [31, 1, 3, 3, 5, 8, 13, 17, 29, 30, 99, 22];
    expect(getInertWhitespaceAssistantTagsByNumbers(db, "by-number", requested)).toEqual(
        all
            .filter((tag) => requested.includes(tag.tagNumber))
            .sort((a, b) => a.tagNumber - b.tagNumber),
    );
    expect(
        getInertWhitespaceAssistantTagsByNumbers(
            db,
            "by-number",
            Array.from({ length: 40 }, (_, index) => index + 1),
        ),
    ).toEqual([...all].sort((a, b) => a.tagNumber - b.tagNumber));
    expect(getInertWhitespaceAssistantTagsByNumbers(db, "by-number", [])).toEqual([]);
    expect(getInertWhitespaceAssistantTagsByNumbers(db, "other", [3, 5])).toEqual([
        { tagNumber: 5, contentId: "m5:p1" },
    ]);
});

it("preserves dropped replay chunk ordering and reloads statuses on cached statements", () => {
    const db = database();
    for (let i = 1; i <= 3; i++) insertTag(db, "dropped", `m${i}:p0`, "message", 1, i);
    updateTagStatus(db, "dropped", 1, "dropped");
    updateTagStatus(db, "dropped", 3, "dropped");
    expect(getDroppedTagsByNumbers(db, "dropped", [3, 2, 1, 1]).map((t) => t.tagNumber)).toEqual([
        1, 3,
    ]);
    const large = [...Array.from({ length: 900 }, () => 3), 1, 3];
    expect(getDroppedTagsByNumbers(db, "dropped", large).map((t) => t.tagNumber)).toEqual([
        3, 1, 3,
    ]);
    updateTagStatus(db, "dropped", 2, "dropped");
    expect(getDroppedTagsByNumbers(db, "dropped", [2]).map((t) => t.tagNumber)).toEqual([2]);
    expect(getTagById(db, "dropped", 2)?.status).toBe("dropped");
    expect(getTagNumberByMessageId(db, "dropped", "m2:p0")).toBe(2);
});

it("isolates decoded frozen decisions from callers and keys on complete encoded bytes", () => {
    const encoded = (id: string, parts: (string | number)[]) =>
        `__merged_reasoning_parts_v1__:${JSON.stringify([id, parts])}`;
    const first = encoded("frozen", [1, "stable-id"]);
    const values = new Set([first, encoded("frozen", [2]), "bad record"]);
    expect(readFrozenMergedReasoningParts(values).get("frozen")).toEqual([1, "stable-id"]);
    readFrozenMergedReasoningParts(values).get("frozen")?.push("not-durable");
    expect(readFrozenMergedReasoningParts(values).get("frozen")).toEqual([1, "stable-id"]);
    expect(readFrozenMergedReasoningParts(new Set([encoded("frozen", [2])])).get("frozen")).toEqual(
        [2],
    );
});
