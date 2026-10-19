import type { Database } from "../../shared/sqlite";
import { renderUserFacingFailure } from "../../shared/user-facing-codes";
import { hasRawSessionMessageById } from "./read-session-chunk";

/** A summary boundary omitted from a request is missing only if the store no longer holds its row. */
export function storedHistoryBoundaryPresence(
    db: Database,
    sessionId: string,
): boolean | undefined {
    try {
        const row = db
            .prepare(
                "SELECT cached_m0_last_baseline_end_message_id AS id FROM session_meta WHERE session_id = ?",
            )
            .get(sessionId) as { id?: string | null } | undefined;
        return row?.id ? hasRawSessionMessageById(sessionId, row.id) : undefined;
    } catch {
        return undefined;
    }
}

/**
 * The transform could not cut the conversation at the history boundary, and
 * the uncut request is larger than the model's context window. Sending it
 * would only earn a provider rejection, so the pass stops here: the messages
 * wrapper replays the last good request when it can and otherwise refuses the
 * turn with this message.
 */
export class UnresolvedHistoryBoundaryError extends Error {
    readonly code = "UNRESOLVED_HISTORY_BOUNDARY";
    readonly recoverable = true;

    constructor(
        readonly estimatedTokens: number,
        readonly contextLimitTokens: number,
        readonly boundaryPresent?: boolean,
    ) {
        const reason =
            boundaryPresent === true
                ? "The boundary row is present in the host store but out of order relative to the loaded history. "
                : boundaryPresent === false
                  ? "The boundary row is missing from the host store. "
                  : "";
        super(reason + renderUserFacingFailure("history_boundary_unresolved", "plain"));
        this.name = "UnresolvedHistoryBoundaryError";
    }
}
