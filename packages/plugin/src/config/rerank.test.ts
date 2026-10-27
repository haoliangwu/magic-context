import { expect, test } from "bun:test";
import { stripUnsafeProjectConfigFields } from "./project-security";
import { RerankConfigSchema } from "./schema/magic-context";
import { substituteConfigVariables } from "./variable";

const KEY = "FAKE_RERANK_CONFIG_SECRET_765";
test("project rerank strips routing credentials and limits but permits only off", () => {
    for (const provider of ["remote", "synapse", "off", "{env:RERANK_TEST_SECRET}"]) {
        const raw: Record<string, unknown> = {
            rerank: {
                provider,
                endpoint: "https://untrusted.invalid",
                model: "untrusted",
                api_key: KEY,
                timeout_ms: 9999,
                top_n: 1,
            },
        };
        const warnings = stripUnsafeProjectConfigFields(raw);
        expect(raw).toEqual(provider === "off" ? { rerank: { provider: "off" } } : {});
        expect(warnings).toHaveLength(1);
        expect(warnings[0]).toContain("projects may only set rerank.provider to off");
        expect(JSON.stringify(warnings)).not.toContain(KEY);
    }
    const off = { rerank: { provider: "off" } };
    expect(stripUnsafeProjectConfigFields(off)).toEqual([]);
    expect(off.rerank).toEqual({ provider: "off" });
});

test("rerank keys use existing user variable expansion while project tokens stay literal", () => {
    const previous = process.env.MC_TEST_RERANK_SECRET;
    process.env.MC_TEST_RERANK_SECRET = KEY;
    try {
        const text = JSON.stringify({
            rerank: {
                provider: "remote",
                endpoint: "https://trusted.invalid",
                model: "reranker",
                api_key: "{env:MC_TEST_RERANK_SECRET}",
                timeout_ms: 1500,
            },
        });
        const user = substituteConfigVariables({ text, isProjectConfig: false });
        expect(RerankConfigSchema.parse(JSON.parse(user.text).rerank).api_key).toBe(KEY);
        const projectText = text.replace(
            "{env:MC_TEST_RERANK_SECRET}",
            "{env:MC_TEST_RERANK_SECRET}{file:never-open-this-secret}",
        );
        const project = substituteConfigVariables({ text: projectText, isProjectConfig: true });
        expect(project.text).toBe(projectText);
        expect(project.warnings).toHaveLength(1);
        expect(project.warnings[0]).not.toContain(KEY);
        const raw = JSON.parse(project.text);
        stripUnsafeProjectConfigFields(raw);
        expect(raw).toEqual({});
    } finally {
        if (previous === undefined) delete process.env.MC_TEST_RERANK_SECRET;
        else process.env.MC_TEST_RERANK_SECRET = previous;
    }
});
