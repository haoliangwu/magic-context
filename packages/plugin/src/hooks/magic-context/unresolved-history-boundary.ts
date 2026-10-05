import { renderUserFacingFailure } from "../../shared/user-facing-codes";

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
    ) {
        super(renderUserFacingFailure("history_boundary_unresolved", "plain"));
        this.name = "UnresolvedHistoryBoundaryError";
    }
}
