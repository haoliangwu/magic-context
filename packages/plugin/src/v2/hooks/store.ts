import type { RawMessage } from "../../hooks/magic-context/read-session-raw";
import type { StoreRow } from "../store-reader";

const isRawRow = (row: StoreRow) =>
    ["user", "synthetic", "assistant", "skill", "shell", "system"].includes(row.type);

/** Ordinals count conversational rows in the complete session, never a post-fold window.
 * A window caller must supply the full history so compaction cannot reassign tag identities. */
export function rawMessages(
    rows: readonly StoreRow[],
    history: readonly StoreRow[] = rows,
): RawMessage[] {
    const ordinals = new Map(history.filter(isRawRow).map((row, index) => [row.id, index + 1]));
    return rows.filter(isRawRow).map((row) => ({
        id: row.id,
        ordinal: ordinals.get(row.id)!,
        role: row.type === "assistant" ? "assistant" : "user",
        createdAt: row.data.time?.created,
        parts:
            row.type === "assistant"
                ? (row.data.content ?? []).map((part) => {
                      if (part.type !== "tool") return { ...part };
                      const state = part.state as Record<string, unknown>;
                      const content = state.content as
                          | Array<{ type: string; text?: string }>
                          | undefined;
                      return {
                          type: "tool",
                          tool: part.name,
                          callID: part.id,
                          state: {
                              ...state,
                              output:
                                  content
                                      ?.filter((p) => p.type === "text")
                                      .map((p) => p.text)
                                      .join("\n") ?? "",
                          },
                      };
                  })
                : [{ type: "text", text: row.data.text ?? "" }],
    }));
}
