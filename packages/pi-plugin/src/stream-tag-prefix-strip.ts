/**
 * Hide the model's leading `§N§ ` tag prefix from Pi's live assistant stream.
 *
 * The Magic Context prompt asks the model to open every text reply with the
 * next tag handle (`§12§ Reading both files…`). That handle is for the model
 * and for Magic Context, not for the user. `message_end` already strips it
 * before Pi persists the reply (see `strip-tag-prefix.ts`), but the same bytes
 * have by then been streamed as `text_delta` events, which Pi's JSON and RPC
 * modes write to stdout as they arrive. Clients that paint from those deltas
 * showed `§12§ ` at the start of every reply.
 *
 * This handler rewrites the outbound `message_update` event instead:
 * - `text_delta`: the opening of each text block is held only while it can
 *   still be tag notation (whitespace, `§`, digits). As soon as the opening
 *   is a complete prefix followed by real text, the prefix is dropped and the
 *   rest is released in the same delta; as soon as it cannot be a prefix, the
 *   held characters are released unchanged. Text that does not start with `§`
 *   or whitespace is never held. A `§N§` later in the block is left alone.
 * - `text_end`: its `content` (the whole block) loses the same prefix, so it
 *   matches the concatenated deltas.
 * - the snapshots carried by the same event (`event.message.content` and
 *   `assistantMessageEvent.partial.content`) are replaced with copies whose
 *   text parts show the same visible text, so an in-process subscriber never
 *   sees stripped deltas next to an unstripped snapshot. The objects the
 *   provider is still appending to are never modified, so the final message
 *   reaching `message_end` (and the persistence strip there) is unchanged.
 *
 * HOST-ORDER DEPENDENCY: `message_update` handlers have no rewrite result in
 * Pi's extension API. This works only because Pi's `AgentSession` awaits
 * extension handlers before notifying its public listeners (the JSON/RPC
 * writer and the TUI) and hands both the same `assistantMessageEvent` object
 * and the same `message` object. If a future Pi clones the event before the
 * extension hooks, or notifies listeners first, these edits silently stop
 * reaching the stream. `stream-tag-prefix-strip-host-order.test.ts` drives a
 * real Pi session to catch that. Oh My Pi notifies its listeners before it
 * queues extension handlers, so nothing an extension does there can change
 * the stream; the handler is not registered on Oh My Pi.
 *
 * Fail-safe: any event whose shape is not what is expected, or whose fields
 * cannot be written, is left untouched, and the handler never throws.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Tag ids longer than this are not treated as a prefix, so a run of digits cannot hold text back for long. */
const MAX_TAG_DIGITS = 12;

/** Leading whitespace plus any complete `§N§` handles, each with its trailing whitespace. */
const LEADING_NOTATION = new RegExp(`^\\s*(?:§\\d{1,${MAX_TAG_DIGITS}}§\\s*)*`);

/** An unfinished handle at the end of the held text: `§` followed by up to the maximum digits. */
const UNFINISHED_HANDLE = new RegExp(`^§\\d{0,${MAX_TAG_DIGITS}}$`);

export type StreamHeadDecision =
	/** The text so far could still be the start of a prefix: show nothing yet. */
	| { kind: "hold" }
	/** The text starts with a complete prefix of this length followed by real text. */
	| { kind: "strip"; prefixLength: number }
	/** The text does not start with a prefix: show it unchanged. */
	| { kind: "pass" };

/** Decide how the opening of an assistant text block is shown. */
export function classifyStreamHead(text: string): StreamHeadDecision {
	const leading = LEADING_NOTATION.exec(text)?.[0] ?? "";
	const rest = text.slice(leading.length);
	if (rest.length === 0 || UNFINISHED_HANDLE.test(rest))
		return { kind: "hold" };
	if (leading.includes("§"))
		return { kind: "strip", prefixLength: leading.length };
	return { kind: "pass" };
}

type BlockState =
	/** Opening still undecided; `held` is every character received so far. */
	| { mode: "holding"; held: string }
	/** Decided: `prefix` was removed from the start of the block. */
	| { mode: "stripped"; prefix: string }
	/** Decided: the block is shown as the model wrote it. */
	| { mode: "pass" };

interface MessageStreamState {
	blocks: Map<number, BlockState>;
	/** Set once an event could not be rewritten; the rest of the message is left as Pi sent it. */
	disabled: boolean;
}

/** Text the user should see for a block, given what has been decided for it. */
function visibleText(text: string, state: BlockState | undefined): string {
	if (state?.mode === "pass") return text;
	if (state?.mode === "stripped") {
		return text.startsWith(state.prefix)
			? text.slice(state.prefix.length)
			: text;
	}
	// Undecided, or a block whose deltas have not been seen yet: apply the same
	// rule the deltas will follow.
	const decision = classifyStreamHead(text);
	if (decision.kind === "hold") return "";
	if (decision.kind === "strip") return text.slice(decision.prefixLength);
	return text;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object";
}

/** True when `obj[key] = value` would take effect on an ordinary data property. */
function canWrite(obj: object, key: string): boolean {
	const descriptor = Object.getOwnPropertyDescriptor(obj, key);
	if (descriptor === undefined) return Object.isExtensible(obj);
	return descriptor.writable === true;
}

/**
 * Copy of `content` whose text parts show their visible text, or undefined
 * when nothing would change (the common no-prefix case allocates nothing).
 */
function visibleContent(
	content: unknown,
	blocks: Map<number, BlockState>,
): unknown[] | undefined {
	if (!Array.isArray(content)) return undefined;
	let copy: unknown[] | undefined;
	for (let index = 0; index < content.length; index++) {
		const part = content[index];
		if (
			!isRecord(part) ||
			part.type !== "text" ||
			typeof part.text !== "string"
		)
			continue;
		const shown = visibleText(part.text, blocks.get(index));
		if (shown === part.text) continue;
		copy ??= content.slice();
		copy[index] = { ...part, text: shown };
	}
	return copy;
}

interface PendingWrite {
	target: object;
	key: string;
	value: unknown;
}

/**
 * Apply the stream rewrite to one Pi `message_update` event in place.
 *
 * Exported for tests; production registers it through
 * {@link registerStreamTagPrefixStrip}.
 */
export function rewriteMessageUpdateEvent(
	event: unknown,
	state: MessageStreamState,
): void {
	if (state.disabled || !isRecord(event)) return;
	const message = event.message;
	const update = event.assistantMessageEvent;
	if (!isRecord(message) || message.role !== "assistant" || !isRecord(update))
		return;
	if (typeof update.type !== "string") return;

	const index = update.contentIndex;
	const hasIndex =
		typeof index === "number" && Number.isInteger(index) && index >= 0;
	const writes: PendingWrite[] = [];
	// Block transitions are staged and committed only together with the writes,
	// so a skipped event leaves the recorded state matching what was streamed.
	let nextBlock: BlockState | undefined;

	if (update.type === "text_start" && hasIndex) {
		nextBlock = { mode: "holding", held: "" };
	} else if (update.type === "text_delta" && hasIndex) {
		if (typeof update.delta !== "string") return;
		const current = state.blocks.get(index) ?? { mode: "holding", held: "" };
		if (current.mode === "holding") {
			const held = current.held + update.delta;
			const decision = classifyStreamHead(held);
			let shown: string;
			if (decision.kind === "hold") {
				nextBlock = { mode: "holding", held };
				shown = "";
			} else if (decision.kind === "strip") {
				nextBlock = {
					mode: "stripped",
					prefix: held.slice(0, decision.prefixLength),
				};
				shown = held.slice(decision.prefixLength);
			} else {
				nextBlock = { mode: "pass" };
				shown = held;
			}
			if (shown !== update.delta)
				writes.push({ target: update, key: "delta", value: shown });
		}
	} else if (update.type === "text_end" && hasIndex) {
		if (typeof update.content !== "string") return;
		const current = state.blocks.get(index);
		const shown = visibleText(update.content, current);
		// A block that ended while still undecided was nothing but notation or
		// whitespace; nothing of it was streamed, so keep hiding all of it.
		if (current === undefined || current.mode === "holding") {
			nextBlock =
				shown === ""
					? { mode: "stripped", prefix: update.content }
					: shown === update.content
						? { mode: "pass" }
						: {
								mode: "stripped",
								prefix: update.content.slice(
									0,
									update.content.length - shown.length,
								),
							};
		}
		if (shown !== update.content)
			writes.push({ target: update, key: "content", value: shown });
	}

	// Snapshots must agree with the deltas, using the state as it will be after
	// this event. `message` is Pi's per-event shallow copy and `partial` is only
	// re-pointed on the event, so the provider's own message is never touched.
	let blocks = state.blocks;
	if (nextBlock !== undefined && hasIndex) {
		blocks = new Map(state.blocks);
		blocks.set(index, nextBlock);
	}
	const messageContent = visibleContent(message.content, blocks);
	if (messageContent !== undefined) {
		writes.push({ target: message, key: "content", value: messageContent });
	}
	const partial = update.partial;
	if (isRecord(partial)) {
		const partialContent = visibleContent(partial.content, blocks);
		if (partialContent !== undefined) {
			writes.push({
				target: update,
				key: "partial",
				value: { ...partial, content: partialContent },
			});
		}
	}

	if (!writes.every((write) => canWrite(write.target, write.key))) {
		// A frozen or read-only event: leave this and the rest of the message as
		// Pi produced it rather than streaming a partly rewritten reply.
		state.disabled = true;
		return;
	}
	for (const write of writes) {
		(write.target as Record<string, unknown>)[write.key] = write.value;
	}
	if (nextBlock !== undefined && hasIndex) state.blocks.set(index, nextBlock);
}

export function createMessageStreamState(): MessageStreamState {
	return { blocks: new Map(), disabled: false };
}

/**
 * Register the stream rewrite. `isActive` mirrors the `message_end` strip:
 * when it returns false (compaction-off mode) the stream is left alone.
 */
export function registerStreamTagPrefixStrip(
	pi: Pick<ExtensionAPI, "on">,
	isActive: () => boolean,
): void {
	// One state per session manager, so two sessions in one process never share
	// block decisions. The fallback key covers contexts without a session manager.
	const states = new WeakMap<object, MessageStreamState>();
	const fallbackKey = {};
	const keyFor = (ctx: unknown): object => {
		const sessionManager = isRecord(ctx) ? ctx.sessionManager : undefined;
		return isRecord(sessionManager) ? sessionManager : fallbackKey;
	};
	const isAssistant = (event: unknown): boolean =>
		isRecord(event) &&
		isRecord(event.message) &&
		event.message.role === "assistant";

	pi.on("message_start", (event, ctx) => {
		try {
			if (isAssistant(event))
				states.set(keyFor(ctx), createMessageStreamState());
		} catch {
			// A stale context must not break Pi's stream.
		}
	});
	// Pi awaits this handler before notifying its public listeners, so every
	// edit is made before the handler returns.
	pi.on("message_update", (event, ctx) => {
		try {
			if (!isActive() || !isAssistant(event)) return;
			const key = keyFor(ctx);
			let state = states.get(key);
			if (state === undefined) {
				state = createMessageStreamState();
				states.set(key, state);
			}
			rewriteMessageUpdateEvent(event, state);
		} catch {
			// Never let a display rewrite break Pi's stream.
		}
	});
	pi.on("message_end", (event, ctx) => {
		try {
			if (isAssistant(event)) states.delete(keyFor(ctx));
		} catch {
			// A stale context must not break Pi's stream.
		}
	});
}
