import { sessionLog } from "../../shared/logger";
import type { PassOutcome } from "./pass-outcome";
import { RawOrdinalsNotReady } from "./read-session-raw";

/**
 * Record an error from the transform's compartment-trigger evaluation.
 *
 * Every error keeps the same degradation record on the pass, including raw
 * ordinals that are still warming, so whether the pass's served bytes can be
 * captured as the last good request stays exactly as it was. Ordinals that are
 * not ready are logged as a deferral rather than a failure: the trigger is
 * evaluated again on the next pass.
 */
export function recordCompartmentTriggerError(
    passOutcome: Pick<PassOutcome, "record">,
    sessionId: string,
    error: unknown,
    log: (sessionId: string, message: string, data?: unknown) => void = sessionLog,
): void {
    passOutcome.record("compartment-trigger-failure");
    if (error instanceof RawOrdinalsNotReady) {
        log(
            sessionId,
            "compartment trigger deferred: raw ordinals not ready; the next pass evaluates it again",
        );
        return;
    }
    log(sessionId, "compartment trigger failed (non-fatal):", error);
}
