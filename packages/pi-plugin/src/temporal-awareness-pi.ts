/**
 * Pi-side temporal-marker injection — mirrors OpenCode's
 * `injectTemporalMarkers` (packages/plugin/src/hooks/magic-context/temporal-awareness.ts).
 *
 * For authored user messages, uses the same gap formatting as OpenCode: when the
 * gap between the previous message's effective end time and the current
 * user message's creation time exceeds TEMPORAL_AWARENESS_THRESHOLD_SECONDS
 * (5 minutes), prepends an HTML-comment marker to the user message's
 * first text content (`<!-- +12m -->\n`, `<!-- +2h 15m -->\n`, etc.).
 *
 * Pi differences:
 *   - The legacy Pi surface also annotated transport-only user messages. An
 *     upgrade replays those bytes rather than silently changing eligibility.
 *   - Pi messages carry a single `timestamp` (number, ms epoch). Pi has
 *     no separate created/completed fields the way OpenCode does — the
 *     timestamp is when the message was emitted. We use that for both
 *     "previous end time" and "current creation time", which is the
 *     same effective behavior OpenCode falls back to for non-completed
 *     messages (see effectiveEndMs in temporal-awareness.ts).
 *   - Pi user messages have `content: string | (TextContent | ImageContent)[]`.
 *     We mutate the first text content (or convert string → array+text).
 *
 * Runtime replay uses persisted message-id decisions; timestamps are only
 * consulted when collecting candidates for a rebuilding pass.
 */

import {
	peelLeadingMcTagNotation,
	stripTagPrefix,
} from "@magic-context/core/hooks/magic-context/tag-content-primitives";
import {
	TEMPORAL_MARKER_PATTERN,
	TEMPORAL_MARKER_REPLAY_PATTERN,
	temporalMarkerPrefix,
} from "@magic-context/core/hooks/magic-context/temporal-awareness";

type PiTextContent = { type: "text"; text: string; textSignature?: string };
type PiImageContent = { type: "image"; data: string; mimeType: string };
type PiUserMessage = {
	role: "user";
	content: string | (PiTextContent | PiImageContent)[];
	timestamp?: number;
};
type PiOtherMessage = {
	role: "assistant" | "toolResult" | string;
	timestamp?: number;
};
type PiAgentMessage = PiUserMessage | PiOtherMessage;

/** Remove one derived gap marker while preserving any leading MC tag notation. */
export function withoutPiLeadingTemporalMarker(text: string): string {
	const { tagPrefix, body } = peelLeadingMcTagNotation(text);
	return tagPrefix + body.replace(TEMPORAL_MARKER_PATTERN, "");
}

export function stripPiLeadingTemporalMarker(message: unknown): boolean {
	if (!message || typeof message !== "object") return false;
	const userMessage = message as PiUserMessage;
	if (userMessage.role !== "user") return false;

	if (typeof userMessage.content === "string") {
		const stripped = withoutPiLeadingTemporalMarker(userMessage.content);
		if (stripped === userMessage.content) return false;
		userMessage.content = stripped;
		return true;
	}
	if (!Array.isArray(userMessage.content)) return false;
	const firstTextIndex = userMessage.content.findIndex(
		(part) => part?.type === "text",
	);
	if (firstTextIndex < 0) return false;
	const firstText = userMessage.content[firstTextIndex] as PiTextContent;
	const stripped = withoutPiLeadingTemporalMarker(firstText.text);
	if (stripped === firstText.text) return false;
	const content = userMessage.content.slice();
	content[firstTextIndex] = { ...firstText, text: stripped };
	userMessage.content = content;
	return true;
}

/**
 * Inject HTML-comment gap markers into Pi user messages. Mirrors
 * OpenCode's `injectTemporalMarkers` 1:1 in agent-visible behavior;
 * differences are limited to the message-shape walking and write
 * back into Pi's content union.
 *
 * Returns the number of user messages that received a new marker.
 */
export function collectPiTemporalCandidates(
	messages: unknown[],
	entryIds: readonly (string | undefined)[],
): Map<string, string> {
	const candidates = new Map<string, string>();
	let previous: number | undefined;
	for (let i = 0; i < messages.length; i++) {
		const message = messages[i] as PiAgentMessage | undefined;
		if (!message || typeof message !== "object") continue;
		const id = entryIds[i];
		if (id && message.role === "user") {
			candidates.set(
				id,
				previous !== undefined && typeof message.timestamp === "number"
					? (temporalMarkerPrefix((message.timestamp - previous) / 1000) ?? "")
					: "",
			);
		}
		if (typeof message.timestamp === "number") previous = message.timestamp;
	}
	return candidates;
}

export function injectPiTemporalMarkers(
	messages: unknown[],
	frozen?: ReadonlyMap<string, string>,
	resolveId?: (message: unknown, index: number) => string | undefined,
): number {
	let injected = 0;
	let prevTimestampMs: number | undefined;

	for (let i = 0; i < messages.length; i++) {
		const raw = messages[i];
		if (!raw || typeof raw !== "object") continue;
		const msg = raw as PiAgentMessage;
		const role = msg.role;
		if (frozen) {
			const marker = resolveId
				? frozen.get(resolveId(raw, i) ?? "")
				: undefined;
			if (marker !== undefined && role === "user") {
				const user = msg as PiUserMessage;
				const apply = (text: string) => {
					const { tagPrefix, body } = peelLeadingMcTagNotation(text);
					const source = body.replace(TEMPORAL_MARKER_REPLAY_PATTERN, "");
					return tagPrefix + (source ? marker + source : marker.trimEnd());
				};
				if (typeof user.content === "string") {
					const content = apply(user.content);
					if (content !== user.content) {
						user.content = content;
						injected++;
					}
				} else if (Array.isArray(user.content)) {
					const index = user.content.findIndex((part) => part?.type === "text");
					const part = user.content[index] as PiTextContent | undefined;
					if (part) {
						const text = apply(part.text);
						if (text !== part.text) {
							user.content = user.content.slice();
							user.content[index] = { ...part, text };
							injected++;
						}
					}
				}
			}
			continue;
		}

		const currTimestamp = msg.timestamp;
		// Compute gap from previous-any-role message → current user message.
		// Matches OpenCode: any role triggers the "previous time" baseline,
		// only user role receives the marker.
		if (
			prevTimestampMs !== undefined &&
			role === "user" &&
			typeof currTimestamp === "number"
		) {
			const gapSec = (currTimestamp - prevTimestampMs) / 1000;
			const prefix = temporalMarkerPrefix(gapSec);
			if (prefix !== null) {
				const userMsg = msg as PiUserMessage;
				if (typeof userMsg.content === "string") {
					if (!TEMPORAL_MARKER_PATTERN.test(stripTagPrefix(userMsg.content))) {
						const { tagPrefix, body } = peelLeadingMcTagNotation(
							userMsg.content,
						);
						(messages as PiAgentMessage[])[i] = {
							...userMsg,
							content: tagPrefix + prefix + body,
						};
						injected++;
					}
				} else if (Array.isArray(userMsg.content)) {
					const firstTextIndex = userMsg.content.findIndex(
						(p) =>
							p &&
							typeof p === "object" &&
							(p as { type?: unknown }).type === "text",
					);
					if (firstTextIndex >= 0) {
						const existing = userMsg.content[firstTextIndex] as PiTextContent;
						const { tagPrefix, body } = peelLeadingMcTagNotation(existing.text);
						if (!TEMPORAL_MARKER_PATTERN.test(body)) {
							const newContent = userMsg.content.slice();
							newContent[firstTextIndex] = {
								...existing,
								text: tagPrefix + prefix + body,
							};
							(messages as PiAgentMessage[])[i] = {
								...userMsg,
								content: newContent,
							};
							injected++;
						}
					}
				}
			}
		}

		// Use the current message's timestamp as the baseline for the
		// next iteration. Falls back to keeping the previous value when
		// the current message has no timestamp (e.g. malformed input).
		if (typeof currTimestamp === "number") {
			prevTimestampMs = currTimestamp;
		}
	}

	return injected;
}
