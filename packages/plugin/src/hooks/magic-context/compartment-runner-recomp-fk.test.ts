import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Static guards for the historian_runs FK linkage. The bug: recomp records its
// model invocations under subagent='recomp', but the telemetry row was linked
// via getLatestHistorianInvocationId() which filters subagent='historian' — so
// every recomp historian_runs row pointed at a stale pre-upgrade incremental
// invocation instead of the actual recomp pass. The fix threads the exact
// successful-attempt invocation id through ValidatedHistorianPassResult.

const recompSrc = readFileSync(join(import.meta.dir, "compartment-runner-recomp.ts"), "utf8");
const historianSrc = readFileSync(join(import.meta.dir, "compartment-runner-historian.ts"), "utf8");

test("recomp links historian_runs FK via the threaded validatedPass.invocationId", () => {
    // Both the success and the terminal-failure record sites must use the exact
    // invocation id carried by the validated pass result.
    const matches = recompSrc.match(/subagentInvocationId:\s*validatedPass\.invocationId/g);
    expect(matches).not.toBeNull();
    // success record + failure record = at least two sites.
    expect((matches ?? []).length).toBeGreaterThanOrEqual(2);
});

test("recomp does NOT use the kind-filtered latest-invocation lookup for the FK", () => {
    // getLatestHistorianInvocationId filters subagent='historian' and would
    // mislink recomp (subagent='recomp') rows. It must not appear in recomp.
    expect(recompSrc.includes("getLatestHistorianInvocationId")).toBe(false);
});

test("recomp records a terminal failure row (status failed + reason)", () => {
    // Honors the historian_runs design intent: capture whether a run failed and
    // why, not only successes.
    expect(recompSrc).toContain('status: "failed"');
    // Prefer the selected reason, retaining validation text for parse failures
    // and a summarized class for external errors.
    expect(recompSrc).toContain(
        "failureReason: validatedPass.failureReason ?? validatedPass.error",
    );
});

test("runValidatedHistorianPass threads invocationId on every success path", () => {
    // first-pass, repair, editor-accepted, and fallback success returns must all
    // carry the producing attempt's invocation id so the caller can link it.
    expect(historianSrc).toContain("invocationId: firstRun.invocationId");
    expect(historianSrc).toContain("invocationId: repairRun.invocationId");
    expect(historianSrc).toContain("invocationId: editorRun.invocationId");
    expect(historianSrc).toContain("invocationId: fallbackRun.invocationId");
});
