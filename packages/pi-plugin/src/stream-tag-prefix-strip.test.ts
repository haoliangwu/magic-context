import { describe, expect, it } from "bun:test";
import { stripPersistedAssistantText } from "@magic-context/core/hooks/magic-context/tag-content-primitives";
import {
	classifyStreamHead,
	createMessageStreamState,
	registerStreamTagPrefixStrip,
	rewriteMessageUpdateEvent,
} from "./stream-tag-prefix-strip";
import { stripTagPrefixFromAssistantMessage } from "./strip-tag-prefix";

type TextPart = { type: "text"; text: string };
type Update = Record<string, unknown>;

/**
 * Emulates how Pi's providers and agent loop build `message_update` events:
 * one provider-owned message that every delta is appended to, a per-event
 * shallow copy as `event.message`, and the provider message as `partial`.
 */
function createStream(role = "assistant") {
	const output = { role, content: [] as TextPart[] };
	const state = createMessageStreamState();
	const send = (update: Update) => {
		const event = {
			type: "message_update",
			message: { ...output },
			assistantMessageEvent: { ...update, partial: output },
		};
		rewriteMessageUpdateEvent(event, state);
		return event;
	};
	return {
		output,
		state,
		start(index = output.content.length) {
			output.content.push({ type: "text", text: "" });
			return send({ type: "text_start", contentIndex: index });
		},
		delta(delta: string, index = output.content.length - 1) {
			output.content[index].text += delta;
			return send({ type: "text_delta", contentIndex: index, delta });
		},
		end(index = output.content.length - 1) {
			return send({
				type: "text_end",
				contentIndex: index,
				content: output.content[index].text,
			});
		},
	};
}

function streamed(deltas: string[]) {
	const stream = createStream();
	stream.start();
	const events = deltas.map((delta) => stream.delta(delta));
	const end = stream.end();
	return {
		stream,
		events,
		end,
		shown: events.map((event) => event.assistantMessageEvent.delta as string),
	};
}

function snapshotText(
	event: { message: { content: unknown } },
	index = 0,
): string {
	return ((event.message.content as TextPart[])[index] as TextPart).text;
}

function partialText(
	event: { assistantMessageEvent: Update },
	index = 0,
): string {
	const partial = event.assistantMessageEvent.partial as {
		content: TextPart[];
	};
	return partial.content[index].text;
}

describe("classifyStreamHead", () => {
	it("holds only what can still become a prefix", () => {
		for (const text of [
			"",
			" ",
			"§",
			"§12",
			"§12§",
			"§12§ ",
			"§12§ §4",
			"\n§1",
		]) {
			expect(classifyStreamHead(text)).toEqual({ kind: "hold" });
		}
	});

	it("strips a complete prefix once real text follows", () => {
		expect(classifyStreamHead("§12§ Hi")).toEqual({
			kind: "strip",
			prefixLength: 5,
		});
		expect(classifyStreamHead("§12§Hi")).toEqual({
			kind: "strip",
			prefixLength: 4,
		});
		expect(classifyStreamHead("§1§ §2§  Hi")).toEqual({
			kind: "strip",
			prefixLength: 9,
		});
	});

	it("passes text that cannot be a prefix", () => {
		for (const text of [
			"H",
			"Hello §1§",
			"§12 apples",
			"§ x",
			"§5.1",
			`§${"9".repeat(13)}`,
		]) {
			expect(classifyStreamHead(text)).toEqual({ kind: "pass" });
		}
	});
});

describe("rewriteMessageUpdateEvent", () => {
	it("holds a prefix split across deltas and releases the reply without it", () => {
		const split = streamed(["§12", "3§ ", "Hello ", "world"]);
		expect(split.shown).toEqual(["", "", "Hello ", "world"]);
		// The snapshots on the same events agree with the deltas sent so far.
		expect(split.events.map((event) => snapshotText(event))).toEqual([
			"",
			"",
			"Hello ",
			"Hello world",
		]);
		expect(split.events.map((event) => partialText(event))).toEqual([
			"",
			"",
			"Hello ",
			"Hello world",
		]);
		expect(split.end.assistantMessageEvent.content).toBe("Hello world");

		const perCharacter = streamed(["§", "1", "2", "§", " ", "Hi"]);
		expect(perCharacter.shown.join("")).toBe("Hi");
		expect(perCharacter.shown.slice(0, 5)).toEqual(["", "", "", "", ""]);
	});

	it("streams a reply with no prefix unchanged, delta for delta, without copying snapshots", () => {
		const { events, shown, end } = streamed(["Hello", " world"]);
		expect(shown).toEqual(["Hello", " world"]);
		for (const event of events) {
			expect(event.message.content).toBe(
				event.assistantMessageEvent.partial.content,
			);
		}
		expect(end.assistantMessageEvent.content).toBe("Hello world");
	});

	it("keeps a §N§ that appears later in the reply", () => {
		expect(streamed(["§4§ See §9§ there"]).shown).toEqual(["See §9§ there"]);
		expect(streamed(["Hi ", "§9§ there"]).shown).toEqual(["Hi ", "§9§ there"]);
		const end = streamed(["§4§ See §9§ there"]).end;
		expect(end.assistantMessageEvent.content).toBe("See §9§ there");
	});

	it("releases held characters unchanged once they cannot be a prefix", () => {
		// Delivered in one delta; the split form is covered by the split test.
		expect(streamed(["§12 apples"]).shown).toEqual(["§12 apples"]);
		expect(streamed(["\n\nHello"]).shown).toEqual(["\n\nHello"]);
	});

	it("leaves the provider's message alone, so the persisted text is unchanged", () => {
		const raw = "§123§ Hello §9§ world";
		const { stream } = streamed(["§123§ ", "Hello ", "§9§ world"]);
		expect(stream.output.content[0].text).toBe(raw);
		// stripTagPrefixFromAssistantMessage (the message_end strip) still gives
		// the same saved text as when no stream rewrite ran.
		const finalMessage = { role: "assistant", content: stream.output.content };
		stripTagPrefixFromAssistantMessage(finalMessage);
		expect(finalMessage.content[0].text).toBe(stripPersistedAssistantText(raw));
		expect(finalMessage.content[0].text).toBe("Hello  world");
	});

	it("hides a block that is nothing but notation", () => {
		const { shown, end } = streamed(["§12§"]);
		expect(shown).toEqual([""]);
		expect(end.assistantMessageEvent.content).toBe("");
		expect(snapshotText(end)).toBe("");
	});

	it("handles each text block on its own", () => {
		const stream = createStream();
		stream.start();
		stream.delta("§3§ First");
		stream.end();
		stream.start();
		const second = stream.delta("Second");
		expect(second.assistantMessageEvent.delta).toBe("Second");
		expect(snapshotText(second, 0)).toBe("First");
		expect(snapshotText(second, 1)).toBe("Second");
	});

	it("does not touch user messages or non-text updates", () => {
		const user = createStream("user");
		user.start();
		expect(user.delta("§4§ hi").assistantMessageEvent.delta).toBe("§4§ hi");

		const state = createMessageStreamState();
		const thinking = {
			message: { role: "assistant", content: [] },
			assistantMessageEvent: {
				type: "thinking_delta",
				contentIndex: 0,
				delta: "§4§ x",
			},
		};
		rewriteMessageUpdateEvent(thinking, state);
		expect(thinking.assistantMessageEvent.delta).toBe("§4§ x");
	});

	it("leaves malformed or frozen events alone without throwing", () => {
		const state = createMessageStreamState();
		for (const event of [
			null,
			7,
			{},
			{ message: { role: "assistant" } },
			{
				message: { role: "assistant" },
				assistantMessageEvent: {
					type: "text_delta",
					contentIndex: 0,
					delta: 5,
				},
			},
		]) {
			expect(() => rewriteMessageUpdateEvent(event, state)).not.toThrow();
		}

		const frozen = Object.freeze({
			message: Object.freeze({
				role: "assistant",
				content: Object.freeze([{ type: "text", text: "§4§ hi" }]),
			}),
			assistantMessageEvent: Object.freeze({
				type: "text_delta",
				contentIndex: 0,
				delta: "§4§ hi",
			}),
		});
		expect(() => rewriteMessageUpdateEvent(frozen, state)).not.toThrow();
		expect(frozen.assistantMessageEvent.delta).toBe("§4§ hi");
		expect(state.disabled).toBe(true);
	});
});

describe("registerStreamTagPrefixStrip", () => {
	type Handler = (event: unknown, ctx: unknown) => void;
	function register(isActive: () => boolean) {
		const handlers = new Map<string, Handler>();
		registerStreamTagPrefixStrip(
			{
				on: (name: string, handler: Handler) => handlers.set(name, handler),
			} as never,
			isActive,
		);
		const ctx = { sessionManager: {} };
		const update = (delta: string) => {
			const event = {
				message: {
					role: "assistant",
					content: [{ type: "text", text: delta }],
				},
				assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta },
			};
			handlers.get("message_update")?.(event, ctx);
			return event.assistantMessageEvent.delta;
		};
		return { handlers, ctx, update };
	}

	it("rewrites the stream while active and resets at each assistant message", () => {
		const { handlers, ctx, update } = register(() => true);
		handlers.get("message_start")?.({ message: { role: "assistant" } }, ctx);
		expect(update("§1§ hi")).toBe("hi");
		handlers.get("message_end")?.({ message: { role: "assistant" } }, ctx);
		handlers.get("message_start")?.({ message: { role: "assistant" } }, ctx);
		expect(update("§2§ again")).toBe("again");
	});

	it("leaves the stream alone when Magic Context's tag stripping is off", () => {
		const { handlers, ctx, update } = register(() => false);
		handlers.get("message_start")?.({ message: { role: "assistant" } }, ctx);
		expect(update("§1§ hi")).toBe("§1§ hi");
	});
});
