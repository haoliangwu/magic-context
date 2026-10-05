import { readFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readHostSystemPrompt } from "./host-system-prompt";
import { promptFingerprint } from "./subagent-telemetry";

export const HISTORIAN_TEMPERATURE_ENV = "MAGIC_CONTEXT_HISTORIAN_TEMPERATURE";
export const HISTORIAN_MAX_OUTPUT_TOKENS_ENV =
	"MAGIC_CONTEXT_HISTORIAN_MAX_OUTPUT_TOKENS";

function finiteNumber(value: string | undefined): number | undefined {
	if (value === undefined || value.trim().length === 0) return undefined;
	const parsed = Number(value);
	return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

/**
 * Apply the historian calibration to each provider's serialized request shape.
 *
 * Both knobs are optional and applied independently: reasoning models reject
 * `temperature` outright, so an output-token budget must still be applicable
 * on its own.
 */
export function calibrateHistorianProviderPayload(
	payload: unknown,
	temperature: number | undefined,
	maxOutputTokens: number | undefined,
): unknown {
	if (typeof payload !== "object" || payload === null || Array.isArray(payload))
		return payload;
	if (temperature === undefined && maxOutputTokens === undefined)
		return payload;
	const calibrated = { ...(payload as Record<string, unknown>) };
	const generationConfig = calibrated.generationConfig;
	if (
		typeof generationConfig === "object" &&
		generationConfig !== null &&
		!Array.isArray(generationConfig)
	) {
		calibrated.generationConfig = {
			...(generationConfig as Record<string, unknown>),
			...(temperature !== undefined ? { temperature } : {}),
			...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
		};
		return calibrated;
	}
	const inferenceConfig = calibrated.inferenceConfig;
	if (
		typeof inferenceConfig === "object" &&
		inferenceConfig !== null &&
		!Array.isArray(inferenceConfig)
	) {
		calibrated.inferenceConfig = {
			...(inferenceConfig as Record<string, unknown>),
			...(temperature !== undefined ? { temperature } : {}),
			...(maxOutputTokens !== undefined ? { maxTokens: maxOutputTokens } : {}),
		};
		return calibrated;
	}

	if (temperature !== undefined) {
		calibrated.temperature = temperature;
	}
	if (maxOutputTokens !== undefined) {
		if ("max_output_tokens" in calibrated) {
			calibrated.max_output_tokens = maxOutputTokens;
		} else if ("max_completion_tokens" in calibrated) {
			calibrated.max_completion_tokens = maxOutputTokens;
		} else if ("max_tokens" in calibrated) {
			calibrated.max_tokens = maxOutputTokens;
		} else if ("maxTokens" in calibrated) {
			calibrated.maxTokens = maxOutputTokens;
		}
	}
	return calibrated;
}

export default function historianCalibrationExtension(pi: ExtensionAPI): void {
	const intendedPath = process.env.MAGIC_CONTEXT_SUBAGENT_PROMPT_FILE;
	if (intendedPath) {
		const intended = readFileSync(intendedPath, "utf8");
		// context runs after ALL before_agent_start handlers have composed the prompt.
		// Unlike before_provider_request it also runs for custom provider extensions.
		pi.on("context", (_event, ctx) => {
			const effective = readHostSystemPrompt(ctx);
			if (effective === undefined) return;
			process.stdout.write(
				`${JSON.stringify({ type: "mc_system_prompt", ...promptFingerprint(effective), containsIntended: effective.includes(intended) })}\n`,
			);
		});
	}
	// Dreamer loads this entry for observation, not historian sampling calibration.
	if (process.env.MAGIC_CONTEXT_SUBAGENT_PROVENANCE_ONLY === "1") return;
	const temperature = finiteNumber(process.env[HISTORIAN_TEMPERATURE_ENV]);
	const maxOutputTokens = finiteNumber(
		process.env[HISTORIAN_MAX_OUTPUT_TOKENS_ENV],
	);
	if (temperature === undefined && maxOutputTokens === undefined) return;
	pi.on("before_provider_request", (event) =>
		calibrateHistorianProviderPayload(
			event.payload,
			temperature,
			maxOutputTokens,
		),
	);
}
