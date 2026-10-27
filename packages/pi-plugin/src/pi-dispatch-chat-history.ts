/**
 * History-only equivalences for Oh My Pi (OMP) 18.10.4's Chat serializer.
 * Source citations below are in @oh-my-pi/pi-ai/src/providers/.
 */
import { piOmitsTruncatedAssistant } from "./pi-dispatch-assistant-history";
import { piToolCallPairing } from "./pi-dispatch-tool-pairing";

export interface PiChatHistoryModel {
	api?: string;
	id?: string;
	provider?: string;
	input?: readonly string[];
	compat?: unknown;
	requiresToolResultImageHoisting?: boolean;
}

export type PiChatHistoryStep =
	| { kind: "source"; index: number }
	| { kind: "note"; text: string }
	| { kind: "images"; urls: readonly string[] };

const MAX_EXACT_UNITS = 32 * 1024 * 1024;
const IMAGE_CAPTION = "Attached image(s) from tool result:";

function object(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function omitsAssistant(
	message: Record<string, unknown>,
	model: PiChatHistoryModel,
	compat: Record<string, unknown>,
): boolean {
	if (!Array.isArray(message.content)) return false;
	if (piOmitsTruncatedAssistant(message)) return true;
	let thinking = false;
	for (const value of message.content) {
		const block = object(value);
		if (!block) return false;
		if (block.type === "text") {
			if (typeof block.text !== "string" || block.text.trim()) return false;
		} else if (block.type === "thinking") {
			if (typeof block.thinking !== "string") return false;
			thinking ||= block.thinking.trim().length > 0;
		} else return false;
	}
	if (compat.requiresReasoningContentForAllAssistantTurns === true)
		return false;
	if (!thinking) return true;
	// The Chat serializer drops reasoning that this model cannot replay. Reasoning
	// from a different provider/model may instead become visible assistant text;
	// keep that row unless the current model's omission is established.
	// openai-completions.ts:2470-2573,2691-2704.
	return (
		message.api === model.api &&
		message.provider === model.provider &&
		message.model === model.id &&
		compat.requiresThinkingAsText !== true &&
		compat.requiresReasoningContentForToolCalls !== true &&
		compat.replayReasoningContent !== true &&
		compat.mistralReasoningContentParts !== true &&
		compat.thinkingFormat !== "zai"
	);
}

/** Snapshot omitted assistants, exact orphan-result notes and positioned tool images. */
export function piChatHistoryPlan(
	messages: readonly unknown[],
	model: PiChatHistoryModel | undefined,
): readonly PiChatHistoryStep[] | undefined {
	if (model?.api !== "openai-completions") return undefined;
	const compat = object(model.compat) ?? {};
	// The input is the shared host-window projection, so every result already
	// sits in its call's window: Oh My Pi moved it there when another message
	// interrupted the window. Results pair with calls by the host's pairing key,
	// so a Responses composite whose item half differs from its call's is still
	// that call's result, never a <stale-tool-result> note.
	const pairingId = piToolCallPairing(messages);
	const calls = new Set<string>();
	for (const value of messages) {
		const message = object(value);
		if (message?.role !== "assistant" || !Array.isArray(message.content))
			continue;
		for (const value of message.content) {
			const block = object(value);
			if (block?.type === "toolCall" && typeof block.id === "string")
				calls.add(pairingId(block.id));
		}
	}
	const transformed: PiChatHistoryStep[] = [];
	let pending = new Set<string>();
	let exactUnits = 0;
	for (let index = 0; index < messages.length; index++) {
		const message = object(messages[index]);
		if (!message) return undefined;
		if (
			(message.role === "bashExecution" ||
				message.role === "pythonExecution") &&
			message.excludeFromContext === true
		)
			continue;
		if (
			message.role === "assistant" ||
			message.role === "user" ||
			message.role === "developer"
		)
			pending = new Set();
		if (message.role === "assistant") {
			if (omitsAssistant(message, model, compat)) continue;
			if (Array.isArray(message.content))
				for (const value of message.content) {
					const block = object(value);
					if (block?.type === "toolCall" && typeof block.id === "string")
						pending.add(pairingId(block.id));
				}
		}
		if (
			message.role === "toolResult" &&
			typeof message.toolCallId === "string"
		) {
			pending.delete(pairingId(message.toolCallId));
			if (!calls.has(pairingId(message.toolCallId))) {
				// Unpaired results become <stale-tool-result> user messages only when no
				// earlier tool call is still awaiting a result. Freeze the note from this
				// managed pass. Later redaction/obfuscation changes its bytes and must
				// conservatively refuse rather than admit text the pass did not prepare.
				// transform-messages.ts:1395-1449.
				if (
					pending.size ||
					typeof message.toolName !== "string" ||
					!Array.isArray(message.content)
				)
					return undefined;
				const parts: string[] = [];
				for (const value of message.content) {
					const part = object(value);
					if (
						part?.type === "text" &&
						typeof part.text === "string" &&
						part.text.trim()
					)
						parts.push(part.text);
				}
				if (!parts.length) return undefined;
				const error = message.isError ? ' is-error="true"' : "";
				const template = `<stale-tool-result tool="${message.toolName}" id="${message.toolCallId}"${error}>\n${parts.join("\n")}\n</stale-tool-result>`;
				if (exactUnits + template.length > MAX_EXACT_UNITS) return undefined;
				// Oh My Pi's Chat encoder replaces unpaired UTF-16 surrogates with U+FFFD
				// before sending user text. UTF-8 round-tripping produces those same bytes.
				// openai-completions.ts:2397-2403.
				const text = new TextDecoder().decode(
					new TextEncoder().encode(template),
				);
				exactUnits += text.length;
				if (exactUnits > MAX_EXACT_UNITS) return undefined;
				transformed.push({ kind: "note", text });
				continue;
			}
		}
		transformed.push({ kind: "source", index });
	}
	const steps: PiChatHistoryStep[] = [];
	let images: string[] = [];
	const flushImages = () => {
		if (images.length) {
			steps.push({ kind: "images", urls: images });
			images = [];
		}
	};
	const vision =
		model.input?.includes("image") === true && compat.stripImageInput !== true;
	for (const step of transformed) {
		const message =
			step.kind === "source" ? object(messages[step.index]) : undefined;
		if (message?.role !== "toolResult") flushImages();
		steps.push(step);
		if (
			message?.role !== "toolResult" ||
			!vision ||
			!Array.isArray(message.content)
		)
			continue;
		for (const value of message.content) {
			const block = object(value);
			if (block?.type !== "image") continue;
			// The Chat serializer collects images from adjacent tool results into one
			// captioned user message after all those results. Its exact position binds
			// the images to that result group, not to another turn or call.
			// openai-completions.ts:2706-2779.
			if (compat.requiresAssistantAfterToolResult === true) return undefined;
			let url: string;
			if (typeof block.url === "string") url = block.url;
			else if (
				typeof block.data === "string" &&
				typeof block.mimeType === "string"
			)
				url = `data:${block.mimeType};base64,${block.data}`;
			else return undefined;
			exactUnits += url.length;
			if (exactUnits > MAX_EXACT_UNITS) return undefined;
			images.push(url);
		}
	}
	flushImages();
	return steps;
}

export function piMatchesChatImages(
	content: unknown,
	urls: readonly string[],
): boolean {
	if (!Array.isArray(content) || content.length !== urls.length + 1)
		return false;
	const caption = object(content[0]);
	if (
		caption?.type !== "text" ||
		caption.text !== IMAGE_CAPTION ||
		Object.keys(caption).length !== 2
	)
		return false;
	for (let i = 0; i < urls.length; i++) {
		const block = object(content[i + 1]);
		const image = object(block?.image_url);
		if (
			block?.type !== "image_url" ||
			Object.keys(block).length !== 2 ||
			!image ||
			Object.keys(image).length !== 1 ||
			image.url !== urls[i]
		)
			return false;
	}
	return true;
}
