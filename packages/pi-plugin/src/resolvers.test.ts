import { describe, expect, it } from "bun:test";
import { MagicContextConfigSchema } from "@magic-context/core/config/schema/magic-context";
import { getProactiveCompartmentTriggerPercentage } from "@magic-context/core/hooks/magic-context/compartment-trigger";
import {
	resolveCacheTtl,
	resolveExecuteThresholdDetail,
} from "@magic-context/core/hooks/magic-context/event-resolvers";
import {
	canonicalPiModelKey,
	resolveDreamerFromConfig,
	resolveHistorianFromConfig,
} from "./index";

describe("Pi config resolvers", () => {
	it("selects the same muse percentage and token thresholds as OpenCode", () => {
		const modelKey = canonicalPiModelKey(
			"opencode",
			"muse-spark-1.3-contributor-free",
		);
		const config = {
			default: 50,
			"opencode/mimo-v2.6-flash-free": 65,
			"opencode/muse-spark-1.3-contributor-free": 20,
		};
		const percentage = resolveExecuteThresholdDetail(config, modelKey, 65);
		expect(percentage).toEqual({
			percentage: 20,
			mode: "percentage",
			matchedKey: modelKey,
		});
		expect(
			getProactiveCompartmentTriggerPercentage(percentage.percentage),
		).toBe(18);
		expect(
			resolveExecuteThresholdDetail(config, modelKey, 65, {
				tokensConfig: { default: 70_000, [modelKey]: 20_000 },
				contextLimit: 100_000,
			}),
		).toEqual({
			percentage: 20,
			mode: "tokens",
			absoluteTokens: 20_000,
			matchedKey: modelKey,
		});
	});

	it("resolves a Pi-native cache_ttl key on the canonical model leg", () => {
		const modelKey = canonicalPiModelKey("openai-codex", "gpt-5.6-sol");
		expect(modelKey).toBe("openai/gpt-5.6-sol");
		expect(
			resolveCacheTtl(
				{ default: "5m", "openai-codex/gpt-5.6-sol": "60m" },
				modelKey,
			),
		).toBe("60m");
	});

	it("keeps historian temperature opt-in and resolves only the Pi harness block", () => {
		const fixtures = [
			{ temperature: undefined, expected: undefined },
			{ temperature: 0.1, expected: 0.1 },
			{ temperature: 0, expected: 0 },
		] as const;
		for (const fixture of fixtures) {
			const config = MagicContextConfigSchema.parse({
				historian: {
					...(fixture.temperature !== undefined
						? { temperature: fixture.temperature }
						: {}),
					opencode: { model: "open/must-not-leak" },
					pi: { model: "pi/historian" },
				},
			});
			const resolved = resolveHistorianFromConfig(config);
			expect(resolved?.model).toBe("pi/historian");
			expect(resolved?.temperature).toBe(fixture.expected);
		}
	});

	it("resolves OMP overrides with Pi fallback and existing empty defaults", () => {
		const configured = MagicContextConfigSchema.parse({
			historian: {
				pi: { model: "pi/historian", thinking_level: "high" },
				omp: { model: "omp/historian", thinking_level: "auto" },
			},
			dreamer: {
				pi: { model: "pi/dreamer", thinking_level: "medium" },
				omp: { model: "omp/dreamer", thinking_level: "inherit" },
			},
		});
		expect(resolveHistorianFromConfig(configured, "omp")).toMatchObject({
			model: "omp/historian",
			thinkingLevel: "auto",
		});
		expect(resolveDreamerFromConfig(configured)?.omp).toMatchObject({
			model: "omp/dreamer",
			thinking_level: "inherit",
		});

		const piOnly = MagicContextConfigSchema.parse({
			historian: { pi: { model: "pi/historian", thinking_level: "high" } },
			dreamer: { pi: { model: "pi/dreamer", thinking_level: "medium" } },
		});
		expect(resolveHistorianFromConfig(piOnly, "omp")?.model).toBe(
			"pi/historian",
		);
		expect(resolveDreamerFromConfig(piOnly)?.pi?.model).toBe("pi/dreamer");

		const empty = MagicContextConfigSchema.parse({});
		expect(resolveHistorianFromConfig(empty, "omp")).toBeUndefined();
		expect(resolveDreamerFromConfig(empty)).toBeUndefined();
	});

	it("promotes the first Pi-resolvable historian fallback and disables an empty chain", () => {
		const config = MagicContextConfigSchema.parse({
			historian: {
				pi: {
					model: "ollama-cloud/unknown",
					fallback_models: [
						{ model: "anthropic/valid", thinking_level: "low" },
					],
				},
			},
		});
		const registry = {
			find: (provider: string, model: string) =>
				provider === "anthropic" && model === "valid" ? {} : undefined,
		};
		expect(resolveHistorianFromConfig(config, "pi", registry)).toMatchObject({
			model: "anthropic/valid",
			thinkingLevel: "low",
			fallbackModels: [],
		});
		expect(
			resolveHistorianFromConfig(config, "pi", { find: () => undefined }),
		).toBeUndefined();
	});

	it("preserves an OMP historian primary role without enabling configured role fallbacks", () => {
		const config = MagicContextConfigSchema.parse({
			historian: {
				omp: {
					model: "@historian",
					thinking_level: "high",
					fallback_models: ["@cheap", "mock/missing", "mock/known"],
				},
			},
		});
		const registry = {
			find: (provider: string, model: string) =>
				provider === "mock" && model === "known" ? {} : undefined,
		};
		expect(resolveHistorianFromConfig(config, "omp", registry)).toMatchObject({
			model: "@historian",
			thinkingLevel: "high",
			fallbackModels: [{ model: "mock/known" }],
		});
		const aliasOnly = MagicContextConfigSchema.parse({
			historian: { pi: { model: "@historian" } },
		});
		expect(resolveHistorianFromConfig(aliasOnly, "omp", registry)?.model).toBe(
			"@historian",
		);
		expect(
			resolveHistorianFromConfig(aliasOnly, "pi", registry),
		).toBeUndefined();
	});

	it("returns undefined for historian and dreamer when disabled", () => {
		const config = MagicContextConfigSchema.parse({
			historian: { disable: true, model: "test/historian" },
			dreamer: { disable: true, model: "test/dreamer" },
		});

		expect(resolveHistorianFromConfig(config)).toBeUndefined();
		expect(resolveDreamerFromConfig(config)).toBeUndefined();
	});
});
