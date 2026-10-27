import { expect, test } from "bun:test";
import { rerankConfigSummary } from "./rerank-summary";

test("doctor rerank summary never prints credentials or routing strings", () => {
    const key = "FAKE_RERANK_DOCTOR_KEY_765";
    const summary = rerankConfigSummary({
        provider: "remote",
        endpoint: `https://invalid/${key}`,
        api_key: key,
        model: key,
        timeout_ms: 1500,
        top_n: 20,
    });
    expect(summary).toBe(
        "Reranking: remote (explicit ctx_search only; timeout 1500ms, top_n 20; credentials hidden)",
    );
    expect(summary).not.toContain(key);
    expect(rerankConfigSummary()).toContain("local Synapse (default");
    expect(rerankConfigSummary({ provider: "off", timeout_ms: 1500, top_n: 20 })).toBe(
        "Reranking: off",
    );
});
