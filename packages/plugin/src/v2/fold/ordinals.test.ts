import { expect, test } from "bun:test";
import { rawMessages } from "../hooks/store";
import type { StoreRow } from "../store-reader";

test("R39 post-fold raw window retains pre-fold ordinals", () => {
    const rows: StoreRow[] = [
        { id: "u", session_id: "s", seq: 0, type: "user", data: { text: "first" } },
        {
            id: "a",
            session_id: "s",
            seq: 1,
            type: "assistant",
            data: { content: [{ type: "text", text: "second" }] },
        },
        { id: "idle", session_id: "s", seq: 2, type: "idle", data: { outcome: "succeeded" } },
        { id: "tail", session_id: "s", seq: 3, type: "user", data: { text: "unarchived" } },
    ];
    const before = rawMessages(rows);
    const after = rawMessages(rows.slice(3), rows);
    expect(after[0]?.ordinal).toBe(before[2]?.ordinal);
    expect(after[0]?.ordinal).toBe(3);
});
