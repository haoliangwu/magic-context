import { expect, it } from "bun:test";
import { recordCompartmentTriggerError } from "./compartment-trigger-error";
import { createPassOutcome } from "./pass-outcome";
import { RawOrdinalsNotReady } from "./read-session-raw";

function record(error: unknown) {
    const outcome = createPassOutcome();
    const lines: Array<{ message: string; data: unknown }> = [];
    recordCompartmentTriggerError(outcome, "session", error, (_session, message, data) =>
        lines.push({ message, data }),
    );
    outcome.markFinalized();
    return { outcome, lines };
}

it("trigger not-ready keeps the failure degradation but logs a deferral, not a failure", () => {
    const notReady = record(new RawOrdinalsNotReady());
    const failure = record(new Error("boom"));
    // Same degradation as any trigger error, so last-good capture eligibility is unchanged.
    expect(notReady.outcome.degradations).toEqual([
        { site: "compartment-trigger-failure", kind: "degraded" },
    ]);
    expect(notReady.outcome.degradations).toEqual(failure.outcome.degradations);
    expect(notReady.outcome.captureEligible).toBe(false);
    expect(failure.outcome.captureEligible).toBe(false);

    expect(notReady.lines).toEqual([
        {
            message:
                "compartment trigger deferred: raw ordinals not ready; the next pass evaluates it again",
            data: undefined,
        },
    ]);
    expect(notReady.lines[0]?.message).not.toMatch(/fail|error/i);
    expect(failure.lines).toEqual([
        { message: "compartment trigger failed (non-fatal):", data: expect.any(Error) },
    ]);
});
