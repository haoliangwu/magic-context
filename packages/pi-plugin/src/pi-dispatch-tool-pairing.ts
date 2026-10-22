/**
 * Oh My Pi's tool-call pairing key, shared by every prepared-dispatch lane.
 *
 * transformMessages pairs a tool result with its call by this key, not by the
 * raw id. Responses-family calls mint composite ids (`call_id|item_id`) whose
 * result may carry a different item half, so a pipe-bearing id collapses onto
 * its `call_id` component only when a Responses-family assistant minted that
 * component and the id is not itself a pipe-bearing call from another API
 * (Chat Completions treats those as opaque tokens that pair by raw equality).
 * A degenerate `|item` id keeps its full value.
 *
 * @oh-my-pi/pi-ai src/providers/transform-messages.ts: responsesCallComponent,
 * recordToolCallOriginScope (collectToolCallOriginScope in 18.8.9) and
 * toolCallPairingKey. The rules are identical in 18.2.6, 18.8.9, 18.11.3,
 * 18.12.3 and 18.12.5.
 */

const RESPONSES_APIS = new Set([
	"openai-responses",
	"openai-codex-responses",
	"azure-openai-responses",
]);

function object(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

/** The `call_id` half of a composite id; a pipe at index 0 keeps the whole id. */
export function piResponsesCallComponent(id: string): string {
	const pipe = id.indexOf("|");
	return pipe <= 0 ? id : id.slice(0, pipe);
}

/**
 * Build the pairing key for one history. The origin scope comes from every
 * assistant tool call in `messages`, as the host builds it before deduplication.
 */
export function piToolCallPairing(
	messages: readonly unknown[],
): (id: string) => string {
	const responsesComponents = new Set<string>();
	const opaqueCompositeIds = new Set<string>();
	for (const value of messages) {
		const message = object(value);
		if (message?.role !== "assistant" || !Array.isArray(message.content))
			continue;
		const responses = RESPONSES_APIS.has(String(message.api));
		for (const part of message.content) {
			const block = object(part);
			if (block?.type !== "toolCall" || typeof block.id !== "string") continue;
			if (responses)
				responsesComponents.add(piResponsesCallComponent(block.id));
			else if (block.id.includes("|")) opaqueCompositeIds.add(block.id);
		}
	}
	return (id) => {
		const pipe = id.indexOf("|");
		if (pipe <= 0 || opaqueCompositeIds.has(id)) return id;
		const prefix = id.slice(0, pipe);
		return responsesComponents.has(prefix) ? prefix : id;
	};
}
