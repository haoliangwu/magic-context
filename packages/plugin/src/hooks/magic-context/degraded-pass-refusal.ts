import { isTransientSqliteError } from "../../shared/sqlite";
import { renderUserFacingFailure } from "../../shared/user-facing-codes";

/**
 * A transform pass failed at a stage whose output the request depends on: the
 * session's saved drops, truncations or history cut could not be applied, or
 * the pass would have returned the host's raw messages. Serving that pass can
 * send a request several times larger than the previous one, so the pass stops
 * instead. The messages wrapper replays the last good request when it can and
 * otherwise refuses the turn with this message.
 */
export class DegradedPassRefusalError extends Error {
    readonly code = "DEGRADED_PASS_REFUSAL";
    readonly recoverable = true;
    readonly estimatedTokens: number | undefined;
    readonly contextLimitTokens: number | undefined;

    constructor(
        /** The stage that failed, by the name the pass records for it (e.g. "tagging-persistence-failure"). */
        readonly site: string,
        options?: {
            cause?: unknown;
            /** Set when the refusal comes from the served-request size guard. */
            estimatedTokens?: number;
            contextLimitTokens?: number;
        },
    ) {
        super(renderUserFacingFailure("transform_pass_degraded", "plain"), {
            cause: options?.cause,
        });
        this.name = "DegradedPassRefusalError";
        this.estimatedTokens = options?.estimatedTokens;
        this.contextLimitTokens = options?.contextLimitTokens;
    }
}

/**
 * The error a pass throws when a stage it cannot serve without has failed.
 *
 * A SQLite busy or locked error is rethrown unchanged: the messages wrapper
 * already owns that case (replay the last good request, otherwise the
 * storage-busy refusal and its host notice). Any other error becomes a
 * {@link DegradedPassRefusalError}, which the wrapper treats the same way
 * except for the message shown to the user.
 */
export function degradedPassError(site: string, error: unknown): Error {
    // Nested replay stages must keep the first failed stage's refusal intact.
    if (error instanceof DegradedPassRefusalError) return error;
    if (isTransientSqliteError(error) && error instanceof Error) return error;
    return new DegradedPassRefusalError(site, { cause: error });
}
