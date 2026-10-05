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
