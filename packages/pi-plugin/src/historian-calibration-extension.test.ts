import { describe, expect, it } from "bun:test";
import { createTestTempDirFromPath } from "../../plugin/src/shared/test-temp-dir";

import { calibrateHistorianProviderPayload } from "./historian-calibration-extension";

describe("historian provider calibration", () => {
	it("sets the calibration triple on every supported output-budget shape", () => {
		const fixtures = [
			{ input: { max_tokens: 4096 }, key: "max_tokens" },
			{ input: { max_completion_tokens: 4096 }, key: "max_completion_tokens" },
			{ input: { max_output_tokens: 4096 }, key: "max_output_tokens" },
			{ input: { maxTokens: 4096 }, key: "maxTokens" },
		] as const;
		for (const fixture of fixtures) {
			const result = calibrateHistorianProviderPayload(
				fixture.input,
				0.1,
				32_000,
			) as Record<string, unknown>;
			expect(result.temperature).toBe(0.1);
			expect(result[fixture.key]).toBe(32_000);
		}
	});

	it("calibrates nested provider generation shapes without adding invalid top-level fields", () => {
		const result = calibrateHistorianProviderPayload(
			{ generationConfig: { topP: 0.9, maxOutputTokens: 4096 } },
			0.1,
			32_000,
		) as Record<string, unknown>;
		expect(result).toEqual({
			generationConfig: {
				topP: 0.9,
				temperature: 0.1,
				maxOutputTokens: 32_000,
			},
		});
		expect(
			calibrateHistorianProviderPayload(
				{ inferenceConfig: { maxTokens: 4096 } },
				0.1,
				32_000,
			),
		).toEqual({ inferenceConfig: { temperature: 0.1, maxTokens: 32_000 } });
	});

	it("preserves an explicit zero temperature", () => {
		expect(
			calibrateHistorianProviderPayload({ max_tokens: 4096 }, 0, 32_000),
		).toEqual({
			max_tokens: 32_000,
			temperature: 0,
		});
		expect(
			calibrateHistorianProviderPayload(
				{ generationConfig: { maxOutputTokens: 4096 } },
				0,
				32_000,
			),
		).toEqual({
			generationConfig: { maxOutputTokens: 32_000, temperature: 0 },
		});
	});

	it("never sends temperature when it is not configured", () => {
		const fixtures = [
			{ input: { max_tokens: 4096 }, key: "max_tokens" },
			{ input: { max_completion_tokens: 4096 }, key: "max_completion_tokens" },
			{ input: { max_output_tokens: 4096 }, key: "max_output_tokens" },
			{ input: { maxTokens: 4096 }, key: "maxTokens" },
		] as const;
		for (const fixture of fixtures) {
			const result = calibrateHistorianProviderPayload(
				fixture.input,
				undefined,
				32_000,
			) as Record<string, unknown>;
			expect("temperature" in result).toBe(false);
			expect(result[fixture.key]).toBe(32_000);
		}
	});

	it("omits temperature from nested provider shapes when unconfigured", () => {
		expect(
			calibrateHistorianProviderPayload(
				{ generationConfig: { topP: 0.9, maxOutputTokens: 4096 } },
				undefined,
				32_000,
			),
		).toEqual({ generationConfig: { topP: 0.9, maxOutputTokens: 32_000 } });
		expect(
			calibrateHistorianProviderPayload(
				{ inferenceConfig: { maxTokens: 4096 } },
				undefined,
				32_000,
			),
		).toEqual({ inferenceConfig: { maxTokens: 32_000 } });
	});

	it("applies temperature alone when no output budget is configured", () => {
		const result = calibrateHistorianProviderPayload(
			{ max_tokens: 4096 },
			0.1,
			undefined,
		) as Record<string, unknown>;
		expect(result.temperature).toBe(0.1);
		expect(result.max_tokens).toBe(4096);
	});

	it("returns the payload untouched when neither knob is configured", () => {
		const payload = { max_tokens: 4096 };
		expect(
			calibrateHistorianProviderPayload(payload, undefined, undefined),
		).toEqual({ max_tokens: 4096 });
	});
});

it("observes the effective context prompt rather than before-agent input", async () => {
	const { writeFileSync, rmSync } = await import("node:fs");
	const { tmpdir } = await import("node:os");
	const { join } = await import("node:path");
	const { spyOn } = await import("bun:test");
	const { default: extension } = await import(
		"./historian-calibration-extension"
	);
	const root = createTestTempDirFromPath(join(tmpdir(), "mc-provenance-test-"));
	const previous = process.env.MAGIC_CONTEXT_SUBAGENT_PROMPT_FILE;
	const output = spyOn(process.stdout, "write").mockImplementation(() => true);
	try {
		const file = join(root, "prompt");
		writeFileSync(file, "intended");
		process.env.MAGIC_CONTEXT_SUBAGENT_PROMPT_FILE = file;
		const handlers = new Map<
			string,
			(event: unknown, ctx: { getSystemPrompt(): unknown }) => unknown
		>();
		extension({
			on: (
				name: string,
				handler: (
					event: unknown,
					ctx: { getSystemPrompt(): unknown },
				) => unknown,
			) => handlers.set(name, handler),
		} as never);
		expect(handlers.has("before_agent_start")).toBe(false);
		handlers.get("context")?.(
			{},
			{ getSystemPrompt: () => "intended plus extension" },
		);
		const event = JSON.parse(String(output.mock.calls[0]?.[0]));
		expect(event.type).toBe("mc_system_prompt");
		expect(event.bytes).toBe(23);
		expect(event.containsIntended).toBe(true);
		expect(event.sha256).toHaveLength(64);
		expect(JSON.stringify(event)).not.toContain("plus extension");

		// Oh My Pi returns one string per prompt segment (issue 618).
		handlers.get("context")?.(
			{},
			{ getSystemPrompt: () => ["intended", "<project-context>"] },
		);
		const segmented = JSON.parse(String(output.mock.calls[1]?.[0]));
		expect(segmented.type).toBe("mc_system_prompt");
		expect(segmented.bytes).toBe("intended\n\n<project-context>".length);
		expect(segmented.containsIntended).toBe(true);
	} finally {
		output.mockRestore();
		if (previous === undefined)
			delete process.env.MAGIC_CONTEXT_SUBAGENT_PROMPT_FILE;
		else process.env.MAGIC_CONTEXT_SUBAGENT_PROMPT_FILE = previous;
		rmSync(root, { recursive: true, force: true });
	}
});

it("does not apply historian sampling calibration to provenance-only dreamer children", async () => {
	const { default: extension } = await import(
		"./historian-calibration-extension"
	);
	const previous = process.env.MAGIC_CONTEXT_SUBAGENT_PROVENANCE_ONLY;
	const temperature = process.env.MAGIC_CONTEXT_HISTORIAN_TEMPERATURE;
	try {
		process.env.MAGIC_CONTEXT_SUBAGENT_PROVENANCE_ONLY = "1";
		process.env.MAGIC_CONTEXT_HISTORIAN_TEMPERATURE = "0.1";
		const events: string[] = [];
		extension({ on: (name: string) => events.push(name) } as never);
		expect(events).not.toContain("before_provider_request");
	} finally {
		if (previous === undefined)
			delete process.env.MAGIC_CONTEXT_SUBAGENT_PROVENANCE_ONLY;
		else process.env.MAGIC_CONTEXT_SUBAGENT_PROVENANCE_ONLY = previous;
		if (temperature === undefined)
			delete process.env.MAGIC_CONTEXT_HISTORIAN_TEMPERATURE;
		else process.env.MAGIC_CONTEXT_HISTORIAN_TEMPERATURE = temperature;
	}
});

async function withCalibrationHook(
	temperature: string,
	check: (
		hook: (event: { payload: unknown }, ctx: { model?: unknown }) => unknown,
		notices: string[],
	) => void,
	catalog?: unknown,
): Promise<void> {
	const { spyOn } = await import("bun:test");
	const { __temperatureTest } = await import(
		"../../plugin/src/shared/subagent-temperature"
	);
	const { default: extension } = await import(
		"./historian-calibration-extension"
	);
	const keys = [
		"MAGIC_CONTEXT_HISTORIAN_TEMPERATURE",
		"MAGIC_CONTEXT_HISTORIAN_MAX_OUTPUT_TOKENS",
		"MAGIC_CONTEXT_SUBAGENT_PROVENANCE_ONLY",
		"MAGIC_CONTEXT_SUBAGENT_PROMPT_FILE",
		"XDG_CACHE_HOME",
		"OPENCODE_MODELS_PATH",
	];
	const previous = keys.map((key) => process.env[key]);
	// The child reads OpenCode's models.dev cache; give it a private one, never the machine's.
	const { mkdirSync, rmSync, writeFileSync } = await import("node:fs");
	const { tmpdir } = await import("node:os");
	const { join } = await import("node:path");
	const cacheRoot = createTestTempDirFromPath(
		join(tmpdir(), "mc-pi-temperature-catalog-"),
	);
	if (catalog !== undefined) {
		mkdirSync(join(cacheRoot, "opencode"), { recursive: true });
		writeFileSync(
			join(cacheRoot, "opencode", "models.json"),
			JSON.stringify(catalog),
		);
	}
	const notices: string[] = [];
	const output = spyOn(process.stdout, "write").mockImplementation((line) => {
		notices.push(String(line));
		return true;
	});
	__temperatureTest.reset();
	try {
		process.env.MAGIC_CONTEXT_HISTORIAN_TEMPERATURE = temperature;
		process.env.MAGIC_CONTEXT_HISTORIAN_MAX_OUTPUT_TOKENS = "32000";
		delete process.env.MAGIC_CONTEXT_SUBAGENT_PROVENANCE_ONLY;
		delete process.env.MAGIC_CONTEXT_SUBAGENT_PROMPT_FILE;
		process.env.XDG_CACHE_HOME = cacheRoot;
		delete process.env.OPENCODE_MODELS_PATH;
		let hook:
			| ((event: { payload: unknown }, ctx: { model?: unknown }) => unknown)
			| undefined;
		extension({
			on(name: string, handler: typeof hook) {
				if (name === "before_provider_request") hook = handler;
			},
		} as never);
		if (!hook) throw new Error("provider hook was not registered");
		check(hook, notices);
	} finally {
		output.mockRestore();
		keys.forEach((key, index) => {
			if (previous[index] === undefined) delete process.env[key];
			else process.env[key] = previous[index];
		});
		__temperatureTest.reset();
		rmSync(cacheRoot, { recursive: true, force: true });
	}
}

for (const [host, field] of [
	["Pi", "supportsTemperature"],
	["OMP", "supportsSamplingParams"],
] as const) {
	it(`${host} calibrates each resolved model only on affirmative metadata, including fallbacks`, async () => {
		await withCalibrationHook("0.1", (hook, notices) => {
			for (const [id, compat, expected] of [
				["flash", { [field]: true }, 0.1],
				["fallback", { [field]: false }, undefined],
				["unknown", {}, undefined],
			] as const) {
				for (const payload of [
					{ max_output_tokens: 4096, temperature: 0.9 },
					{ generationConfig: { temperature: 0.9, maxOutputTokens: 4096 } },
					{ inferenceConfig: { temperature: 0.9, maxTokens: 4096 } },
				]) {
					const result = hook(
						{ payload },
						{ model: { provider: host, id, compat } },
					) as Record<string, unknown>;
					const options = (result.generationConfig ??
						result.inferenceConfig ??
						result) as Record<string, unknown>;
					expect(options.temperature).toBe(expected);
					if (expected === undefined)
						expect("temperature" in options).toBe(false);
					expect(
						options.max_output_tokens ??
							options.maxOutputTokens ??
							options.maxTokens,
					).toBe(32000);
				}
			}
			expect(notices.map((line) => JSON.parse(line))).toEqual([
				{
					type: "mc_temperature",
					model: `${host}/flash`,
					supported: true,
					source: "host",
				},
				{
					type: "mc_temperature",
					model: `${host}/fallback`,
					supported: false,
					source: "host",
				},
				{
					type: "mc_temperature",
					model: `${host}/unknown`,
					supported: null,
					source: "none",
				},
			]);
		});
	});
}

it("Codex-shaped provider never receives temperature when metadata is missing", async () => {
	await withCalibrationHook("0.1", (hook) => {
		let calls = 0;
		const provider = (payload: Record<string, unknown>) => {
			calls++;
			if ("temperature" in payload)
				throw new Error("Codex error: Unsupported parameter: temperature");
			return "historian manifest";
		};
		const model = {
			provider: "openai-codex",
			id: "gpt-6.1-sol",
			api: "openai-codex-responses",
			reasoning: true,
		};
		for (let run = 0; run < 2; run++) {
			const payload = hook(
				{ payload: { max_output_tokens: 4096 } },
				{ model },
			) as Record<string, unknown>;
			expect(provider(payload)).toBe("historian manifest");
			expect(payload).not.toHaveProperty("temperature");
		}
		expect(calls).toBe(2);
	});
});

it("provider hook honours explicit zero on a supported model", async () => {
	await withCalibrationHook("0", (hook) => {
		const result = hook(
			{ payload: {} },
			{
				model: {
					provider: "mock",
					id: "zero",
					compat: { supportsTemperature: true },
				},
			},
		);
		expect(result).toEqual({ temperature: 0 });
	});
});

// The relevant slice of models.dev as OpenCode caches it.
const MODELS_DEV = {
	google: { models: { "gemini-3.8-flash": { temperature: true } } },
	openrouter: {
		models: {
			"google/gemini-3.8-flash": { temperature: true },
			"openai/gpt-6.1-sol": { temperature: false },
		},
	},
	openai: { models: { "gpt-6.1-sol": { temperature: false } } },
};

it("Pi and OMP Gemini Flash get the historian temperature from the models.dev cache when the registry is silent", async () => {
	await withCalibrationHook(
		"0.1",
		(hook, notices) => {
			// Model shapes as Pi's registry and the Antigravity extension register them: they carry no
			// temperature field, so the models.dev cache must decide.
			for (const model of [
				{
					provider: "openrouter",
					id: "google/gemini-3.8-flash",
					api: "openai-completions",
					compat: { thinkingFormat: "openrouter" },
				},
				{
					provider: "google",
					id: "antigravity-gemini-3.8-flash",
					api: "google-generative-ai",
				},
				{
					provider: "google-antigravity",
					id: "gemini-3.8-flash",
					api: "google-generative-ai",
				},
			]) {
				const result = hook(
					{ payload: { max_output_tokens: 4096 } },
					{ model },
				) as Record<string, unknown>;
				expect(result.temperature).toBe(0.1);
			}
			for (const model of [
				{
					provider: "openai-codex",
					id: "gpt-6.1-sol",
					api: "openai-codex-responses",
				},
				{
					provider: "openrouter",
					id: "openai/gpt-6.1-sol",
					api: "openai-completions",
				},
			]) {
				const result = hook(
					{ payload: { max_output_tokens: 4096, temperature: 1 } },
					{ model },
				) as Record<string, unknown>;
				expect(result).not.toHaveProperty("temperature");
			}
			expect(notices.map((line) => JSON.parse(line))).toEqual([
				{
					type: "mc_temperature",
					model: "openrouter/google/gemini-3.8-flash",
					supported: true,
					source: "catalog",
					entry: "openrouter/google/gemini-3.8-flash",
				},
				{
					type: "mc_temperature",
					model: "google/antigravity-gemini-3.8-flash",
					supported: true,
					source: "catalog",
					entry: "google/gemini-3.8-flash",
				},
				{
					type: "mc_temperature",
					model: "google-antigravity/gemini-3.8-flash",
					supported: true,
					source: "catalog",
					entry: "google/gemini-3.8-flash",
				},
				{
					type: "mc_temperature",
					model: "openai-codex/gpt-6.1-sol",
					supported: null,
					source: "none",
				},
				{
					type: "mc_temperature",
					model: "openrouter/openai/gpt-6.1-sol",
					supported: false,
					source: "catalog",
					entry: "openrouter/openai/gpt-6.1-sol",
				},
			]);
		},
		MODELS_DEV,
	);
});
