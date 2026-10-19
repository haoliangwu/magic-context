import { expect, test } from "bun:test";
import { classifyZenFreeTierFailure } from "./pi-zen-free-tier";

test("Zen refusal classification preserves other providers and unrelated errors byte-for-byte", () => {
	for (const model of ["anthropic/fixture", "openai/fixture", undefined]) {
		const result = {
			ok: false as const,
			reason: "model_failed" as const,
			error: "403 FreeTierError raw body",
			durationMs: 10,
			meta: { stderr: "original diagnostics" },
		};
		expect(classifyZenFreeTierFailure(result, model, "historian", "pi")).toBe(
			result,
		);
	}
	for (const error of [
		"403 AuthenticationError",
		"429 quota exceeded",
		"503 service unavailable",
		"model unavailable",
	]) {
		const result = {
			ok: false as const,
			reason: "model_failed" as const,
			error,
			durationMs: 10,
		};
		expect(
			classifyZenFreeTierFailure(result, "opencode/free", "historian", "pi"),
		).toBe(result);
	}
});

test("OMP native provider alias classifies the genuine 403 message without exposing the body", () => {
	const result = {
		ok: false as const,
		reason: "no_assistant" as const,
		error:
			"403 OpenCode's free tier can only be used from within OpenCode. BODY_SENTINEL",
		durationMs: 10,
		meta: { stderr: "BODY_SENTINEL" },
	};
	const classified = classifyZenFreeTierFailure(
		result,
		"opencode-zen/free",
		"dreamer-classifier",
		"omp",
	);
	expect(classified).toMatchObject({
		ok: false,
		reason: "no_assistant",
		meta: { failureClass: "opencode_zen_free_tier" },
	});
	expect(JSON.stringify(classified)).not.toContain("BODY_SENTINEL");
});
