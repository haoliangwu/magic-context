import { expect, it } from "bun:test";
import { protectedToolTokenCount } from "@magic-context/core/features/magic-context/reclaim-protection";
import type { TagEntry } from "@magic-context/core/features/magic-context/types";
import { resolveDecisionCalibration } from "@magic-context/core/hooks/magic-context/decision-calibration";
import {
	outgoingContextRefusal,
	PROTECTED_TOOL_RESULTS_OVER_LIMIT,
} from "@magic-context/core/hooks/magic-context/emergency-fail-closed";
import { readPiLkgFitEnvelope } from "./pi-lkg-fit-envelope";
import {
	assertPiRawFallbackFits,
	estimatePiOutgoingInputTokens,
} from "./pi-raw-fallback";
import { tokenizePiMessages } from "./tokenize-pi-messages";

it("Pi healthy refusal settles huge and small byte bounds without BPE", () => {
	const envelope = {
		modelKey: "unknown/unknown",
		systemTokens: 100,
		toolDefinitionTokens: 0,
	};
	const startedAt = performance.now();
	const huge = estimatePiOutgoingInputTokens(
		[{ role: "toolResult", content: "x".repeat(12 * 1024 * 1024) }],
		envelope,
		undefined,
		16000,
	);
	expect(huge.refusalBasis).toBe("byte-bound");
	expect(huge.refusalGrade).toBe(true);
	expect(performance.now() - startedAt).toBeLessThan(1000);
	const small = estimatePiOutgoingInputTokens(
		[{ role: "user", content: "x".repeat(4000) }],
		envelope,
		undefined,
		16000,
	);
	expect(small.refusalBasis).toBe("byte-bound");
	expect(small.refusalGrade).toBe(false);
});

it("re-review: Pi must not refuse a fitting uncalibrated request on the unknown-model upper envelope", () => {
	const messages = [
		{
			role: "toolResult",
			toolName: "probe",
			toolCallId: "probe-call",
			content: [{ type: "text", text: "word ".repeat(8000) }],
		},
	];
	const unknown = resolveDecisionCalibration(
		"unmeasured-provider",
		"unmeasured-model",
	);
	const envelope = {
		modelKey: unknown.modelKey,
		systemTokens: 100,
		toolDefinitionTokens: 20,
		toolDefinitionsMeasured: true,
		refusalToolDefinitionTokens: 20,
	};
	const estimate = estimatePiOutgoingInputTokens(messages, envelope);
	// This altered ratio checks local token pricing only; it does not prove that
	// the route has a measured calibration suitable for refusing the request.
	const local = estimatePiOutgoingInputTokens(messages, {
		...envelope,
		calibration: { ...unknown, seeded: true },
	});
	expect(local.tokens).toBeLessThan(14000);
	expect(estimate.tokens).toBeGreaterThan(16000);
	expect(estimate.trusted).toBe(true);
	expect(estimate.refusalGrade).toBe(false);
	const protectedMass = protectedToolTokenCount(
		[
			{
				tagNumber: 1,
				type: "tool",
				status: "active",
				toolName: "probe",
				tokenCount: local.tokens - 120,
			} as TagEntry,
		],
		{ probe: 1 },
		unknown,
	);
	expect(
		outgoingContextRefusal(estimate, 16000, protectedMass),
	).toBeUndefined();
});

it("Pi refuses incomplete fallback even when the byte proxy fits", () => {
	expect(() =>
		assertPiRawFallbackFits(
			[{ role: "user", content: "hello" }],
			20000,
			() => {},
			null,
		),
	).toThrow();
});

it("Pi refusal counts active route definitions rather than the all-tools admission envelope", () => {
	const key = "anthropic/claude-fable-5-1";
	const envelope = readPiLkgFitEnvelope(
		{ getSystemPrompt: () => "Helpful system" },
		{
			getAllTools: () => [
				{
					name: "inactive",
					description: "word ".repeat(20000),
					parameters: {},
				},
			],
			getActiveTools: () => [],
		},
		key,
		resolveDecisionCalibration("anthropic", "claude-fable-5-1"),
	);
	const estimate = estimatePiOutgoingInputTokens(
		[{ role: "user", content: "hello" }],
		envelope,
	);
	expect(estimate.tokens).toBeGreaterThan(16000);
	expect(estimate.refusalGrade).toBe(true);
	expect(estimate.refusalTokens).toBeLessThan(1000);
	expect(outgoingContextRefusal(estimate, 16000)).toBeUndefined();
	const missing = { ...envelope!, toolDefinitionsMeasured: false };
	expect(
		estimatePiOutgoingInputTokens(
			[{ role: "user", content: "word ".repeat(20000) }],
			missing,
		).refusalGrade,
	).toBe(false);
	const family = {
		...envelope!,
		modelKey: "anthropic/claude-fable-5-2",
		calibration: resolveDecisionCalibration("anthropic", "claude-fable-5-2"),
	};
	expect(
		estimatePiOutgoingInputTokens(
			[{ role: "user", content: "word ".repeat(20000) }],
			family,
		).refusalGrade,
	).toBe(false);
});

it("Pi admission may retain an unknown freeze while refusal uses the current measured seed", () => {
	const observed = {
		modelKey: "anthropic/claude-fable-5-1",
		systemTokens: 100,
		toolDefinitionTokens: 0,
		refusalToolDefinitionTokens: 0,
		toolDefinitionsMeasured: true,
		calibration: resolveDecisionCalibration(undefined, undefined),
	};
	const estimate = estimatePiOutgoingInputTokens(
		[
			{
				role: "toolResult",
				content: [{ type: "text", text: "word ".repeat(8000) }],
			},
		],
		observed,
	);
	expect(estimate.tokens).toBeGreaterThan(16000);
	expect(estimate.refusalGrade).toBe(true);
	expect(estimate.refusalTokens).toBeLessThan(16000);
	expect(outgoingContextRefusal(estimate, 16000)).toBeUndefined();
});
it("Pi admits a complete calibrated fallback and refuses the locally fitting over-wall request", () => {
	const messages = [{ role: "user", content: "hello" }];
	const observed = {
		modelKey: "anthropic/claude-fable-5-1",
		systemTokens: 10000,
		toolDefinitionTokens: 0,
	};
	expect(() =>
		assertPiRawFallbackFits(messages, 20000, () => {}, null, observed),
	).not.toThrow();
	expect(() =>
		assertPiRawFallbackFits(messages, 12000, () => {}, null, observed),
	).toThrow();
});
it("Pi refuses a complete protected over-limit final envelope but not untrusted counts", () => {
	const messages = [
		{
			role: "toolResult",
			toolCallId: "large",
			toolName: "probe",
			content: [{ type: "text", text: "word ".repeat(12000) }],
		},
	];
	const observed = {
		modelKey: "anthropic/claude-fable-5-1",
		systemTokens: 100,
		toolDefinitionTokens: 0,
		refusalToolDefinitionTokens: 0,
		toolDefinitionsMeasured: true,
	};
	const estimate = estimatePiOutgoingInputTokens(messages, observed);
	expect(estimate.trusted).toBe(true);
	expect(estimate.refusalGrade).toBe(true);
	const rawTools = tokenizePiMessages(messages).toolCall;
	const protectedMass = protectedToolTokenCount(
		[
			{
				tagNumber: 1,
				type: "tool",
				status: "active",
				toolName: "probe",
				tokenCount: rawTools,
			} as TagEntry,
		],
		{ probe: 1 },
		resolveDecisionCalibration("anthropic", "claude-fable-5-1"),
	);
	expect(rawTools).toBeLessThan(16000);
	expect(protectedMass).toBeGreaterThan(16000);
	expect(outgoingContextRefusal(estimate, 16000, protectedMass)).toBe(
		PROTECTED_TOOL_RESULTS_OVER_LIMIT,
	);
	expect(
		outgoingContextRefusal(
			estimatePiOutgoingInputTokens(messages),
			16000,
			96000,
		),
	).toBeUndefined();
	expect(
		outgoingContextRefusal(
			estimatePiOutgoingInputTokens([{ role: "unknown" }], observed),
			16000,
			96000,
		),
	).toBeUndefined();
});
