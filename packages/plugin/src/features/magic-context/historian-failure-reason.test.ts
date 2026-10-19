import { expect, test } from "bun:test";
import {
    capHistorianFailureReason,
    externalHistorianFailureReason,
    subprocessExitHistorianFailureReason,
} from "./historian-failure-reason";

test("external provider failures retain structured codes without persisting message text", () => {
    const reason = externalHistorianFailureReason(
        "OpenAI API error (404): model not found; private provider response",
    );
    expect(reason).toBe("provider_error:http_404:model_not_found");
    expect(reason).not.toContain("private provider response");

    const structured = externalHistorianFailureReason({
        statusCode: 422,
        type: "quota_limit_error",
        code: "quota_burst",
        message: "private response body",
    });
    expect(structured).toBe("provider_error:http_422:quota_limit_error:code_quota_burst");
});

test("external exceptions keep their error class and structured code only", () => {
    const error = Object.assign(new TypeError("private exception body"), {
        code: "EACCES",
    });
    expect(externalHistorianFailureReason(error, "exception")).toBe(
        "exception:code_EACCES:class_TypeError",
    );
});

test("subprocess exit retains launcher diagnostics but rejects arbitrary stderr", () => {
    const launcher =
        "Error: Failed to load extension '/tmp/plugin.js': loadAccounts is not a function";
    expect(subprocessExitHistorianFailureReason(1, `${launcher}\nprivate model output`)).toBe(
        `subprocess_exit:1:${launcher}`,
    );
    expect(subprocessExitHistorianFailureReason(2, "private model output")).toBe(
        "subprocess_exit:2",
    );
});

test("MC-authored failure reasons are preserved verbatim and bounded", () => {
    const reason = `producer_prompt_unfit: ${"x".repeat(600)}`;
    expect(capHistorianFailureReason(reason)).toBe(reason.slice(0, 512));
    expect(capHistorianFailureReason("  ")).toBe("provider_error");
});
