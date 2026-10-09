import {
	calibrationForModelKey,
	type DecisionCalibration,
	hasMeasuredDecisionCalibration,
	providerMass,
} from "@magic-context/core/hooks/magic-context/decision-calibration";
import {
	hasTokenizerForFit,
	tokenCountUsesByteBound,
} from "@magic-context/core/hooks/magic-context/read-session-formatting";
import { UNKNOWN_FIT_RATIO } from "@magic-context/core/hooks/magic-context/tokenizer-calibration";
import { tokenizePiMessages } from "./tokenize-pi-messages";

export class PiStorageBusyError extends Error {
	readonly code = "PI_STORAGE_BUSY";
	readonly recoverable = true;

	constructor(options?: { cause?: unknown }) {
		super("Magic Context storage is busy; send your message again", options);
		this.name = "PiStorageBusyError";
	}
}

/**
 * A stage the served messages depend on failed (tagging, or the replay of the
 * session's persisted drops), so Pi's own messages would go out without the
 * session's reductions. The context handler treats it like a transient storage
 * failure: replay the last good request if it fits, otherwise refuse the turn.
 */
export class PiDegradedPassError extends Error {
	readonly code = "PI_DEGRADED_PASS";
	readonly recoverable = true;

	constructor(
		readonly site: string,
		options?: { cause?: unknown },
	) {
		super(
			"Magic Context could not finish preparing this turn; send your message again",
			options,
		);
		this.name = "PiDegradedPassError";
	}
}

/**
 * Last-resort size guard for Pi's unmodified messages after an ordinary
 * handler failure. True only when the messages alone, without the system
 * prompt and tool definitions, already exceed the limit; a request that is
 * shown to be over it would only be rejected by the provider. Messages that
 * cannot be read or counted are not shown to be over the limit.
 */
export function piRawMessagesExceedLimit(
	messages: readonly unknown[],
	contextLimit: number | undefined,
): { exceeds: boolean; tokens: number | null } {
	if (!contextLimit || !Number.isFinite(contextLimit) || contextLimit <= 0) {
		return { exceeds: false, tokens: null };
	}
	try {
		const raw = tokenizePiMessages([...messages]);
		const tokens = raw.conversation + raw.toolCall;
		return {
			exceeds: Number.isFinite(tokens) && tokens > contextLimit,
			tokens,
		};
	} catch {
		return { exceeds: false, tokens: null };
	}
}

export interface PiFitEnvelope {
	modelKey: string;
	systemTokens: number;
	toolDefinitionTokens: number;
	/** Token count for definitions active on this route, not all registered tools. */
	refusalToolDefinitionTokens?: number;
	toolDefinitionsMeasured?: boolean;
	/** Serialized system-and-tool envelope before conversation messages are added. */
	envelopeBytes?: number;
	/** Identity of the system prompt and tool definitions used for this route. */
	envelopeSignature?: string;
	/** Session's saved fit policy; without one, use the unknown-model rule. */
	calibration?: DecisionCalibration;
}

/** Require current system/tool counts for an estimate. Missing metadata alone
 * must not reject a request. */
export function estimatePiOutgoingInputTokens(
	messages: readonly unknown[],
	observed?: PiFitEnvelope,
	measuredPrefix?: PiMeasuredPrefixFit,
	contextLimit?: number,
): {
	tokens: number;
	trusted: boolean;
	refusalGrade?: boolean;
	refusalTokens?: number;
	refusalBasis?: "calibrated" | "provider-prefix" | "byte-bound";
} {
	if (
		!observed ||
		!Number.isFinite(observed.systemTokens) ||
		observed.systemTokens <= 0 ||
		!Number.isFinite(observed.toolDefinitionTokens) ||
		observed.toolDefinitionTokens < 0 ||
		!hasTokenizerForFit()
	)
		return { tokens: 0, trusted: false };
	const complete = messages.every((message) => {
		if (!message || typeof message !== "object") return false;
		const m = message as { role?: string; content?: unknown };
		return (
			["user", "assistant", "toolResult"].includes(m.role ?? "") &&
			(typeof m.content === "string" ||
				(Array.isArray(m.content) &&
					m.content.every(
						(p) =>
							p &&
							typeof p === "object" &&
							["text", "thinking", "toolCall"].includes(String(p.type)),
					)))
		);
	});
	if (!complete) return { tokens: 0, trusted: false };
	const measuredForBounds =
		measuredPrefix &&
		measuredPrefix.modelKey === observed.modelKey &&
		observed.envelopeSignature &&
		measuredPrefix.envelopeSignature === observed.envelopeSignature &&
		Number.isSafeInteger(measuredPrefix.inputTokens) &&
		measuredPrefix.inputTokens > 0
			? measuredPrefix
			: undefined;
	if (contextLimit && Number.isFinite(contextLimit) && contextLimit > 0) {
		const priced = measuredForBounds?.appendedMessages ?? messages;
		const baseline = measuredForBounds?.inputTokens ?? 0;
		let contentBytes = 0;
		for (const rawMessage of priced) {
			const message = rawMessage as {
				content:
					| string
					| Array<{
							text?: string;
							thinking?: string;
							thinkingSignature?: string;
							textSignature?: string;
							name?: string;
							arguments?: unknown;
					  }>;
			};
			if (typeof message.content === "string")
				contentBytes += Buffer.byteLength(message.content);
			else
				for (const part of message.content) {
					for (const value of [
						part.text,
						part.thinking,
						part.thinkingSignature,
						part.textSignature,
						part.name,
					])
						if (typeof value === "string")
							contentBytes += Buffer.byteLength(value);
					if (part.arguments !== undefined)
						contentBytes += Buffer.byteLength(JSON.stringify(part.arguments));
				}
			if (baseline + Math.ceil(contentBytes / 4) > contextLimit) break;
		}
		const lower = baseline + Math.ceil(contentBytes / 4);
		if (lower > contextLimit)
			return {
				tokens: lower,
				trusted: false,
				refusalGrade: true,
				refusalTokens: lower,
				refusalBasis: "byte-bound",
			};
		const envelope = measuredForBounds
			? baseline
			: providerMass(
					{
						system: observed.systemTokens,
						tools: observed.toolDefinitionTokens,
					},
					observed.calibration ?? calibrationForModelKey(observed.modelKey),
					true,
				);
		const fit =
			observed.calibration ?? calibrationForModelKey(observed.modelKey);
		const upper =
			envelope +
			Math.max(UNKNOWN_FIT_RATIO, fit.toolsRatio, fit.proseRatio) *
				Buffer.byteLength(JSON.stringify(priced));
		if (upper <= contextLimit)
			return {
				tokens: upper,
				trusted: true,
				refusalGrade: false,
				refusalBasis: "byte-bound",
			};
	}
	const bounded = messages.some((rawMessage) => {
		const content = (rawMessage as { content: unknown }).content;
		if (typeof content === "string") return tokenCountUsesByteBound(content);
		return (content as Array<Record<string, unknown>>).some((part) =>
			[
				part.text,
				part.thinking,
				part.thinkingSignature,
				part.textSignature,
				part.name,
				part.arguments === undefined
					? undefined
					: JSON.stringify(part.arguments),
			].some(
				(value) => typeof value === "string" && tokenCountUsesByteBound(value),
			),
		);
	});
	if (bounded)
		return {
			tokens: providerMass(
				{
					system: observed.systemTokens,
					tools:
						observed.toolDefinitionTokens +
						Buffer.byteLength(JSON.stringify(messages)),
				},
				observed.calibration ?? calibrationForModelKey(observed.modelKey),
				true,
			),
			trusted: true,
			refusalGrade: false,
			refusalBasis: "byte-bound",
		};
	const raw = tokenizePiMessages([...messages]);
	const calibration =
		observed.calibration ?? calibrationForModelKey(observed.modelKey);
	// Admission (deciding whether to send) uses the session's saved fit policy.
	// Refusal-grade evidence must instead use this route's measured model seed,
	// never the unknown-model fit multiplier.
	const refusalCalibration = calibrationForModelKey(observed.modelKey);
	const tokens = providerMass(
		{
			system: observed.systemTokens,
			tools: observed.toolDefinitionTokens + raw.toolCall,
			prose: raw.conversation,
		},
		calibration,
		true,
	);
	const refusalGrade =
		Number.isFinite(tokens) &&
		messages.every((rawMessage) => {
			const content = (rawMessage as { content: unknown }).content;
			if (typeof content === "string") return !tokenCountUsesByteBound(content);
			return (content as Array<Record<string, unknown>>).every((part) =>
				[
					part.text,
					part.thinking,
					part.thinkingSignature,
					part.textSignature,
					part.name,
					part.arguments === undefined
						? undefined
						: JSON.stringify(part.arguments),
				].every(
					(value) =>
						typeof value !== "string" || !tokenCountUsesByteBound(value),
				),
			);
		}) &&
		hasMeasuredDecisionCalibration(refusalCalibration) &&
		observed.toolDefinitionsMeasured === true &&
		Number.isFinite(observed.refusalToolDefinitionTokens) &&
		observed.refusalToolDefinitionTokens! >= 0;
	const measured =
		measuredPrefix &&
		measuredPrefix.modelKey === observed.modelKey &&
		observed.envelopeSignature &&
		measuredPrefix.envelopeSignature === observed.envelopeSignature &&
		Number.isSafeInteger(measuredPrefix.inputTokens) &&
		measuredPrefix.inputTokens > 0
			? measuredPrefix
			: undefined;
	const tail = measured
		? tokenizePiMessages([...measured.appendedMessages])
		: raw;
	const refusalTokens = refusalGrade
		? (measured?.inputTokens ?? 0) +
			providerMass(
				{
					system: measured ? 0 : observed.systemTokens,
					tools:
						(measured ? 0 : observed.refusalToolDefinitionTokens!) +
						tail.toolCall,
					prose: tail.conversation,
				},
				refusalCalibration,
			)
		: undefined;
	return {
		tokens,
		trusted: Number.isFinite(tokens),
		refusalGrade,
		refusalTokens,
		refusalBasis: refusalGrade
			? measured
				? "provider-prefix"
				: "calibrated"
			: undefined,
	};
}

export interface PiMeasuredPrefixFit {
	modelKey: string;
	envelopeSignature: string;
	inputTokens: number;
	appendedMessages: readonly unknown[];
}

/** Prefer correlated provider input plus the new tail; otherwise price the full envelope. */
export function assertPiRawFallbackFits(
	messages: readonly unknown[],
	contextLimit: number | undefined,
	log: (message: string) => void,
	cause: unknown,
	observed?: PiFitEnvelope,
	measuredPrefix?: PiMeasuredPrefixFit,
): void {
	if (
		!contextLimit ||
		!Number.isFinite(contextLimit) ||
		!observed ||
		!Number.isFinite(observed.systemTokens) ||
		observed.systemTokens <= 0 ||
		!Number.isFinite(observed.toolDefinitionTokens) ||
		observed.toolDefinitionTokens < 0 ||
		(observed.envelopeBytes !== undefined &&
			(!Number.isFinite(observed.envelopeBytes) || observed.envelopeBytes < 0))
	) {
		log("raw_fallback_refused completeness=partial");
		throw new PiStorageBusyError({ cause });
	}
	const measured =
		measuredPrefix &&
		measuredPrefix.modelKey === observed.modelKey &&
		observed.envelopeSignature &&
		measuredPrefix.envelopeSignature === observed.envelopeSignature &&
		Number.isSafeInteger(measuredPrefix.inputTokens) &&
		measuredPrefix.inputTokens > 0
			? measuredPrefix
			: undefined;
	const baseInputTokens = measured?.inputTokens ?? 0;
	const pricedMessages = measured?.appendedMessages ?? messages;
	log(
		`lkg_fit_basis=${measured ? "provider_input" : "host_metadata"} measured_input=${baseInputTokens}`,
	);
	// Explicit count-only callers use a conservative proxy for their measured
	// envelope. The installed handler supplies the actual serialized host metadata.
	let bytes = measured
		? 1
		: 1 +
			(observed.envelopeBytes ??
				20 + 4 * (observed.systemTokens + observed.toolDefinitionTokens));
	let serializationFailed = false;
	try {
		for (const message of pricedMessages) {
			const serialized = JSON.stringify(message);
			if (typeof serialized !== "string") {
				serializationFailed = true;
				break;
			}
			bytes += Buffer.byteLength(serialized) + 1;
			if (baseInputTokens + Math.ceil(bytes / 4) > contextLimit) break;
		}
	} catch {
		serializationFailed = true;
	}
	const proxyTokens = baseInputTokens + Math.ceil(bytes / 4);
	if (serializationFailed || proxyTokens > contextLimit) {
		log(
			`raw_fallback_over_context_limit proxy_bytes=${bytes} proxy_tokens=${proxyTokens} limit=${contextLimit} early_abort=true serialization_failed=${serializationFailed}`,
		);
		throw new PiStorageBusyError({ cause });
	}
	const complete = pricedMessages.every((message) => {
		if (!message || typeof message !== "object") return false;
		const m = message as { role?: string; content?: unknown };
		return (
			["user", "assistant", "toolResult"].includes(m.role ?? "") &&
			(typeof m.content === "string" ||
				(Array.isArray(m.content) &&
					m.content.every(
						(p: unknown) =>
							p !== null &&
							typeof p === "object" &&
							["text", "thinking", "toolCall"].includes(
								String((p as { type?: unknown }).type),
							),
					)))
		);
	});
	const raw = tokenizePiMessages([...pricedMessages]);
	if (!hasTokenizerForFit()) {
		log("raw_fallback_refused completeness=partial tokenizer=unavailable");
		throw new PiStorageBusyError({ cause });
	}
	const tokens =
		baseInputTokens +
		providerMass(
			{
				system: measured ? 0 : observed.systemTokens,
				tools: (measured ? 0 : observed.toolDefinitionTokens) + raw.toolCall,
				prose: raw.conversation,
			},
			observed.calibration ?? calibrationForModelKey(observed.modelKey),
			true,
		);
	if (
		!complete ||
		!Number.isFinite(tokens) ||
		tokens <= 0 ||
		tokens > contextLimit ||
		serializationFailed ||
		proxyTokens > contextLimit
	) {
		log(
			`raw_fallback_over_context_limit proxy_bytes=${bytes} proxy_tokens=${proxyTokens} limit=${contextLimit} early_abort=true serialization_failed=${serializationFailed}`,
		);
		throw new PiStorageBusyError({ cause });
	}
}
