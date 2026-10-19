import { stripPersistedAssistantText } from "../../hooks/magic-context/tag-content-primitives";

/**
 * Remove `§N§` tag notation that a model copied into its own reply.
 *
 * OpenCode 1 (`experimental.text.complete`) and Pi (`message_end`) run
 * `stripPersistedAssistantText` on assistant text before the host stores it.
 * OpenCode 2 offers no hook between a finished text part and the write to its
 * store: the runner publishes the text-ended event straight to the bus, and the
 * projector writes it. So OpenCode 2 stores copied tags unchanged, and Magic
 * Context strips them from assistant text when it builds each request instead.
 * Without that, every later request hands the copies back to the model, which
 * reinforces the pattern.
 *
 * Depends only on the text, so the same stored reply gives the same bytes on
 * every pass. Text without a `§` comes back untouched: the shared function also
 * trims surrounding whitespace, and trimming text that holds no tag notation
 * would change the bytes of sessions that never had copies.
 */
export function stripCopiedTagNotation(text: string): string {
    return text.includes("\u00a7") ? stripPersistedAssistantText(text) : text;
}
