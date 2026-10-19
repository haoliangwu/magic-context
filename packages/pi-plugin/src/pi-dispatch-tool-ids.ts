import type { PiChatHistoryModel } from "./pi-dispatch-chat-history";

// Provider source locations below use @oh-my-pi/pi-ai 18.10.4. The same ID
// rules were checked against 18.11.0, whose provider line numbers can differ.

function record(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

const sanitize = (id: string) =>
	id.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);

function hash(id: string): string | undefined {
	// OMP hashes with Bun, but the Pi extension can also run under Node. Do not
	// guess a correlation token when the host's hash implementation is absent.
	return typeof Bun === "undefined" ? undefined : Bun.hash(id).toString(36);
}

function responsesComponent(id: string): string {
	const sep = id.search(/[\n|]/);
	return sep > 0 ? id.slice(0, sep) : id;
}

function codexCallId(id: string): string | undefined {
	// Codex strips the item component, then hashes lossy character/length edits
	// so distinct opaque call tokens do not collapse onto the same wire ID.
	// @oh-my-pi/pi-ai 18.10.4 and 18.11.0:
	// src/providers/openai-codex/request-transformer.ts:255-266.
	if (!id) {
		const suffix = hash("empty");
		return suffix === undefined ? undefined : `call_${suffix}`;
	}
	const sep = id.search(/[\n|]/);
	const base = sep > 0 ? id.slice(0, sep) : sep === 0 ? id.slice(1) : id;
	const normalized = base.replace(/[^a-zA-Z0-9_-]/g, "_").replace(/_+$/, "");
	if (normalized && normalized.length <= 64 && normalized === base)
		return normalized;
	const suffix = hash(base || id);
	if (suffix === undefined) return undefined;
	return `${(normalized || "call").slice(0, Math.max(0, 63 - suffix.length))}_${suffix}`.slice(
		0,
		64,
	);
}

/** Expected correlation ID after OMP's transform and provider serialization. */
export function piToolCallWireId(
	id: string,
	model: PiChatHistoryModel,
	source: unknown,
): string | undefined {
	const origin = record(source);
	const same =
		origin !== undefined &&
		origin.provider === model.provider &&
		origin.api === model.api &&
		origin.model === model.id;
	const compat = record(model.compat);
	switch (model.api) {
		case "openai-completions": {
			// Chat treats IDs from the active model as opaque, but strips the item
			// component from foreign composites; explicit compatibility limits win.
			// openai-completions.ts:346-358,2298-2320,2651-2656.
			if (compat?.requiresMistralToolIds === true) {
				const normalized = id.replace(/[^a-zA-Z0-9]/g, "");
				return (
					normalized + "ABCDEFGHI".slice(0, Math.max(0, 9 - normalized.length))
				).slice(0, 9);
			}
			if (!same && id.includes("|"))
				return id
					.split("|", 1)[0]
					.replace(/[^a-zA-Z0-9_-]/g, "_")
					.slice(0, 40);
			return compat?.usesOpenAIToolCallIdLimit === true ? id.slice(0, 40) : id;
		}
		case "anthropic-messages": {
			// transform-messages.ts:527-547,1161-1174; anthropic.ts:5558,5876.
			// A custom endpoint owns same-source opaque IDs, including composites.
			if (same && compat?.officialEndpoint !== true) return id;
			const normalized = sanitize(id);
			if (normalized) return normalized;
			const suffix = hash(id);
			return suffix === undefined ? undefined : `toolu_${suffix}`;
		}
		case "bedrock-converse-stream":
			// amazon-bedrock.ts:1077,1090,1139: serialization sanitizes even
			// same-source IDs, unlike Google's transform-only normalization.
			return sanitize(id);
		case "google-generative-ai":
		case "google-gemini-cli":
		case "google-vertex":
			// google-shared.ts:165-169,251-275,311-319. ID-less function parts
			// are matched by ordered names in pi-dispatch-structure instead.
			return same ? id : sanitize(id);
		case "openai-responses":
		case "azure-openai-responses": {
			// openai-shared.ts:1484-1501,2131-2138,2561,2693; utils.ts:44-55.
			// Only cross-source transforms sanitize the call component. Same-source
			// replay splits the composite but keeps the opaque call token verbatim.
			const sep = id.search(/[\n|]/);
			const simple = sep < 0 && id.length <= 64 && /^[a-zA-Z0-9_-]+$/.test(id);
			const foreign =
				origin &&
				(origin.provider !== model.provider || origin.api !== model.api);
			return !same && !simple && (foreign || sep >= 0 || id.length > 64)
				? codexCallId(responsesComponent(id))
				: responsesComponent(id);
		}
		case "openai-codex-responses":
			// Codex's final request transformer sanitizes every call_id, even for
			// history produced by the active model, unlike ordinary Responses.
			// openai-codex-responses.ts:4976-4989,1603.
			return codexCallId(responsesComponent(id));
		default:
			return id;
	}
}
