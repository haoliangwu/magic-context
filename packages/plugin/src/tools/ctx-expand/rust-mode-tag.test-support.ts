import { insertTag } from "../../features/magic-context/storage";
import { setRawMessageProvider } from "../../hooks/magic-context/read-session-chunk";
import type { Database } from "../../shared/sqlite";

/**
 * A session tagged by the TypeScript transform and later moved to Rust transform
 * mode. In Rust mode the ck-mc module numbers the §N§ tags from its own store,
 * starting from its own counter, and the TypeScript tagger stops writing
 * `context.db.tags`. The old rows stay behind with numbers the module reuses, so
 * `[dropped §75386§]` in the Rust-rendered tail names a recent reply while
 * `context.db` maps 75386 to a months-old message.
 */
export const SESSION_ID = "ses-ts-then-rust";
export const TS_ERA_TEXT =
    "the 4 tests fail identically on the pre-merge build, so the callgraph trio merge did not cause them";
export const TS_ERA_TOOL_OUTPUT = "Saved session note #241";
export const RUST_ERA_REPLY = "Rust-era reply that ck-mc numbered 75386";

export function seedTsEraTagsThenRustHistory(db: Database): () => void {
    // TypeScript-era rows, written before the session moved to Rust mode.
    insertTag(db, SESSION_ID, "msg_ts_text:p2", "message", 120, 75386);
    insertTag(db, SESSION_ID, "toolu_ts_note", "tool", 40, 75394, 0, "ctx_note", 0, "msg_ts_tool");
    db.prepare(
        "UPDATE tags SET status = 'dropped' WHERE session_id = ? AND tag_number IN (75386, 75394)",
    ).run(SESSION_ID);
    return setRawMessageProvider(SESSION_ID, {
        readMessages: () => [
            {
                ordinal: 1,
                id: "msg_ts_text",
                role: "assistant",
                parts: [
                    { type: "step-start" },
                    { type: "reasoning", text: "thinking" },
                    { type: "text", text: TS_ERA_TEXT },
                ],
            },
            {
                ordinal: 2,
                id: "msg_ts_tool",
                role: "assistant",
                parts: [
                    {
                        type: "tool",
                        tool: "ctx_note",
                        callID: "toolu_ts_note",
                        state: { input: { action: "write" }, output: TS_ERA_TOOL_OUTPUT },
                    },
                ],
            },
            // Rust-era replies: ck-mc numbered these 75386 and 75394 in store.db.
            {
                ordinal: 3,
                id: "msg_rust_text",
                role: "assistant",
                parts: [{ type: "text", text: RUST_ERA_REPLY }],
            },
            {
                ordinal: 4,
                id: "msg_rust_tool",
                role: "assistant",
                parts: [
                    {
                        type: "tool",
                        tool: "read",
                        callID: "toolu_rust_read",
                        state: { input: { path: "rust.txt" }, output: "rust-era output" },
                    },
                ],
            },
        ],
    });
}
