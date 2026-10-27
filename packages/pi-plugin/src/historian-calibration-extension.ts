import { readFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { withoutHistorianTailCache } from "@magic-context/core/shared/historian-cache";
import { subagentTemperature } from "@magic-context/core/shared/subagent-temperature";
import { readHostSystemPrompt } from "./host-system-prompt";
import { promptFingerprint } from "./subagent-telemetry";
import { registerSubagentToolBoundary } from "./subagent-tool-boundary";

export const HISTORIAN_TEMPERATURE_ENV = "MAGIC_CONTEXT_HISTORIAN_TEMPERATURE";
export const HISTORIAN_CACHE_TAIL_ENV = "MAGIC_CONTEXT_HISTORIAN_CACHE_TAIL";
/** Exact output cap from configuration (historian.maxTokens or dreamer.maxTokens). */
export const HISTORIAN_MAX_OUTPUT_TOKENS_ENV =
	"MAGIC_CONTEXT_HISTORIAN_MAX_OUTPUT_TOKENS";
/**
 * Default output ceiling for a hidden child with no configured cap. Pi asks for
 * the model's whole output limit, clamped only by the context window, so a 1M
 * window model requests ~936k output tokens. OpenRouter reserves credit for
 * that request and refuses it. The ceiling only lowers the requested cap and
 * never raises it.
 */
export const SUBAGENT_OUTPUT_CEILING_ENV =
	"MAGIC_CONTEXT_SUBAGENT_OUTPUT_CEILING";

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

/**
 * Lower the provider request's output cap to `ceiling` in whichever field the
 * provider uses. A smaller cap the host already chose stays untouched, and a
 * request with no cap field is left alone because its field name is unknown.
 */
export function ceilProviderOutputTokens(
	payload: unknown,
	ceiling: number | undefined,
): unknown {
	if (ceiling === undefined) return payload;
	if (typeof payload !== "object" || payload === null || Array.isArray(payload))
		return payload;
	const lowered = (
		options: Record<string, unknown>,
		keys: readonly string[],
	): Record<string, unknown> => {
		const next = { ...options };
		for (const key of keys) {
			const value = next[key];
			if (typeof value === "number" && value > ceiling) next[key] = ceiling;
		}
		return next;
	};
	const record = payload as Record<string, unknown>;
	const nested = (key: string): Record<string, unknown> | undefined => {
		const value = record[key];
		return typeof value === "object" && value !== null && !Array.isArray(value)
			? (value as Record<string, unknown>)
			: undefined;
	};
	const generationConfig = nested("generationConfig");
	if (generationConfig)
		return {
			...record,
			generationConfig: lowered(generationConfig, ["maxOutputTokens"]),
		};
	const inferenceConfig = nested("inferenceConfig");
	if (inferenceConfig)
		return {
			...record,
			inferenceConfig: lowered(inferenceConfig, ["maxTokens"]),
		};
	const capped = lowered(record, [
		"max_output_tokens",
		"max_completion_tokens",
		"max_tokens",
		"maxTokens",
	]);
	// Anthropic requires thinking.budget_tokens to stay below max_tokens. Pi
	// sized the budget against the uncapped value, so shrink it the same way Pi
	// does when a cap leaves no room: keep 1024 tokens for the answer.
	const thinking = nested("thinking");
	if (
		thinking &&
		typeof capped.max_tokens === "number" &&
		typeof thinking.budget_tokens === "number" &&
		thinking.budget_tokens >= capped.max_tokens
	) {
		capped.thinking = {
			...thinking,
			budget_tokens: Math.max(1024, capped.max_tokens - 1024),
		};
	}
	return capped;
}

/** Remove inherited sampling defaults as well as our override on unsupported models. */
export function withoutProviderTemperature(payload: unknown): unknown {
	if (!payload || typeof payload !== "object" || Array.isArray(payload))
		return payload;
	const clean = { ...(payload as Record<string, unknown>) };
	delete clean.temperature;
	for (const key of ["generationConfig", "inferenceConfig"]) {
		const nested = clean[key];
		if (nested && typeof nested === "object" && !Array.isArray(nested)) {
			const options = { ...(nested as Record<string, unknown>) };
			delete options.temperature;
			clean[key] = options;
		}
	}
	return clean;
}

export default function historianCalibrationExtension(pi: ExtensionAPI): void {
	registerSubagentToolBoundary(pi);
	// Only the hidden-child launcher sets this admission flag. Ordinary sessions
	// and other subagents never register a cache-rewriting listener.
	if (process.env[HISTORIAN_CACHE_TAIL_ENV] === "skip") {
		let requests = 0;
		let warned = false;
		pi.on("before_provider_request", (event) => {
			if (requests++ > 0) return;
			try {
				const original = JSON.stringify(event.payload);
				const body = withoutHistorianTailCache(original);
				return body === original ? undefined : JSON.parse(body);
			} catch (error) {
				if (!warned) {
					warned = true;
					try {
						process.stderr.write(
							`Historian cache optimization skipped: ${String(error)}\n`,
						);
					} catch {
						// Diagnostic failures must not prevent the original request.
					}
				}
				return undefined;
			}
		});
	}
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
	// Dreamer loads this entry for observation and output caps only: historian
	// sampling calibration must never change a dreamer child's temperature.
	const provenanceOnly =
		process.env.MAGIC_CONTEXT_SUBAGENT_PROVENANCE_ONLY === "1";
	const maxOutputTokens = finiteNumber(
		process.env[HISTORIAN_MAX_OUTPUT_TOKENS_ENV],
	);
	const outputCeiling = finiteNumber(process.env[SUBAGENT_OUTPUT_CEILING_ENV]);
	if (provenanceOnly) {
		if (maxOutputTokens === undefined && outputCeiling === undefined) return;
		pi.on("before_provider_request", (event) =>
			ceilProviderOutputTokens(
				calibrateHistorianProviderPayload(
					event.payload,
					undefined,
					maxOutputTokens,
				),
				outputCeiling,
			),
		);
		return;
	}
	const temperature = finiteNumber(process.env[HISTORIAN_TEMPERATURE_ENV]);
	if (temperature === undefined && maxOutputTokens === undefined) {
		if (outputCeiling === undefined) return;
		pi.on("before_provider_request", (event) =>
			ceilProviderOutputTokens(event.payload, outputCeiling),
		);
		return;
	}
	pi.on("before_provider_request", (event, ctx) => {
		const model = ctx.model;
		const key = `${model?.provider ?? "unknown"}/${model?.id ?? "unknown"}`;
		const sampling = subagentTemperature(
			key,
			model,
			temperature,
			(_message, decision) => {
				// Pi may redirect extension stdout to stderr; the parent accepts both
				// and writes the session log line from these fields.
				process.stdout.write(
					`${JSON.stringify({ type: "mc_temperature", model: key, supported: decision.supported ?? null, source: decision.source, ...(decision.entry ? { entry: decision.entry } : {}) })}\n`,
				);
			},
		);
		return ceilProviderOutputTokens(
			calibrateHistorianProviderPayload(
				sampling === undefined
					? withoutProviderTemperature(event.payload)
					: event.payload,
				sampling,
				maxOutputTokens,
			),
			outputCeiling,
		);
	});
}
