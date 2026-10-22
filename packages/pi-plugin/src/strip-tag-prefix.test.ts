import { describe, expect, it } from "bun:test";
import {
	prependTag,
	stripPersistedAssistantText,
} from "@magic-context/core/hooks/magic-context/tag-content-primitives";
import {
	registerOmpAssistantMessageStrip,
	strippedAssistantContent,
	stripTagPrefixFromAssistantMessage,
} from "./strip-tag-prefix";

describe("stripTagPrefixFromAssistantMessage", () => {
	describe("leading tag prefix (canonical MC tagger mimicry)", () => {
		it("strips a single §N§ prefix from assistant text", () => {
			const msg = {
				role: "assistant",
				content: [
					{ type: "text", text: "§4§ Yes. I can see the magic context." },
				],
			};
			const mutated = stripTagPrefixFromAssistantMessage(msg);
			expect(mutated).toBe(true);
			expect((msg.content[0] as { text: string }).text).toBe(
				"Yes. I can see the magic context.",
			);
		});

		it("strips consecutive §N§ prefixes (model-mimicked sequence)", () => {
			const msg = {
				role: "assistant",
				content: [{ type: "text", text: "§3§ §4§ §5§ Hello world" }],
			};
			expect(stripTagPrefixFromAssistantMessage(msg)).toBe(true);
			expect((msg.content[0] as { type: string; text: string }).text).toBe(
				"Hello world",
			);
		});

		it("strips trailing whitespace after the prefix", () => {
			const msg = {
				role: "assistant",
				content: [{ type: "text", text: "§4§   \n\nYes" }],
			};
			expect(stripTagPrefixFromAssistantMessage(msg)).toBe(true);
			expect((msg.content[0] as { type: string; text: string }).text).toBe(
				"Yes",
			);
		});

		it("strips multi-digit tag IDs", () => {
			const msg = {
				role: "assistant",
				content: [{ type: "text", text: "§38773§ Found it." }],
			};
			expect(stripTagPrefixFromAssistantMessage(msg)).toBe(true);
			expect((msg.content[0] as { type: string; text: string }).text).toBe(
				"Found it.",
			);
		});
	});

	describe("cargo-culted § mid-text (models mimicking MC notation)", () => {
		it("preserves decimal section references at the start and inside assistant text", () => {
			const msg = {
				role: "assistant",
				content: [
					{
						type: "text",
						text: "§12.3 cites the specification; see §123.45.",
					},
				],
			};
			expect(stripTagPrefixFromAssistantMessage(msg)).toBe(true);
			expect((msg.content[0] as { type: string; text: string }).text).toBe(
				"12.3 cites the specification; see 123.45.",
			);
		});

		it("removes mid-text §N§ pair entirely (cargo-cult defense)", () => {
			const msg = {
				role: "assistant",
				content: [
					{
						type: "text",
						text: "Looking at §5§ which references the earlier discussion",
					},
				],
			};
			expect(stripTagPrefixFromAssistantMessage(msg)).toBe(true);
			expect((msg.content[0] as { type: string; text: string }).text).toBe(
				"Looking at  which references the earlier discussion",
			);
		});

		it('removes malformed §N"> hybrid mid-text', () => {
			const msg = {
				role: "assistant",
				content: [{ type: "text", text: `Hello §40827">Oracle confirmed` }],
			};
			expect(stripTagPrefixFromAssistantMessage(msg)).toBe(true);
			expect((msg.content[0] as { type: string; text: string }).text).toBe(
				"Hello Oracle confirmed",
			);
		});

		it("strips stray § character anywhere", () => {
			const msg = {
				role: "assistant",
				content: [{ type: "text", text: "See § marker for details" }],
			};
			expect(stripTagPrefixFromAssistantMessage(msg)).toBe(true);
			expect((msg.content[0] as { type: string; text: string }).text).toBe(
				"See  marker for details",
			);
		});

		it("strips both leading prefix and mid-text § in same message", () => {
			const msg = {
				role: "assistant",
				content: [
					{
						type: "text",
						text: "§42§ The pattern §40827§ appeared.",
					},
				],
			};
			expect(stripTagPrefixFromAssistantMessage(msg)).toBe(true);
			expect((msg.content[0] as { type: string; text: string }).text).toBe(
				"The pattern  appeared.",
			);
		});
	});

	describe("scope guards", () => {
		it("does NOT strip prefix on user messages", () => {
			const msg = {
				role: "user",
				content: [{ type: "text", text: "§4§ Hello from user" }],
			};
			expect(stripTagPrefixFromAssistantMessage(msg)).toBe(false);
			expect((msg.content[0] as { type: string; text: string }).text).toBe(
				"§4§ Hello from user",
			);
		});

		it("does NOT strip prefix on tool result messages", () => {
			const msg = {
				role: "toolResult",
				content: [{ type: "text", text: "§7§ tool output" }],
			};
			expect(stripTagPrefixFromAssistantMessage(msg)).toBe(false);
		});

		it("strips across multiple text parts in a single message", () => {
			const msg = {
				role: "assistant",
				content: [
					{ type: "text", text: "§4§ First chunk" },
					{ type: "text", text: "§4§ Second chunk" },
				],
			};
			expect(stripTagPrefixFromAssistantMessage(msg)).toBe(true);
			expect((msg.content[0] as { type: string; text: string }).text).toBe(
				"First chunk",
			);
			expect((msg.content[1] as { type: string; text: string }).text).toBe(
				"Second chunk",
			);
		});

		it("ignores non-text parts (thinking, toolCall, image)", () => {
			const msg = {
				role: "assistant",
				content: [
					{
						type: "thinking",
						thinking: "§4§ pretend reasoning, not stripped",
					},
					{ type: "text", text: "§4§ Real assistant text" },
					{
						type: "toolCall",
						id: "t1",
						name: "ctx_search",
						arguments: {},
					},
				],
			};
			expect(stripTagPrefixFromAssistantMessage(msg)).toBe(true);
			expect((msg.content[1] as { type: string; text: string }).text).toBe(
				"Real assistant text",
			);
			// Thinking part untouched (only text parts are scrubbed)
			expect(
				(msg.content[0] as { type: string; thinking: string }).thinking,
			).toBe("§4§ pretend reasoning, not stripped");
		});
	});

	describe("no-op cases", () => {
		it("returns false when no text parts have any §", () => {
			const msg = {
				role: "assistant",
				content: [{ type: "text", text: "Plain response without any prefix" }],
			};
			expect(stripTagPrefixFromAssistantMessage(msg)).toBe(false);
		});

		it("handles empty content array gracefully", () => {
			const msg = { role: "assistant", content: [] };
			expect(stripTagPrefixFromAssistantMessage(msg)).toBe(false);
		});

		it("handles non-array content gracefully", () => {
			// Pi user messages can have content: string (legacy shape)
			const msg = { role: "assistant", content: "§4§ legacy string" };
			expect(stripTagPrefixFromAssistantMessage(msg)).toBe(false);
			// String content unchanged (we don't touch legacy string-shape on assistants)
			expect(msg.content).toBe("§4§ legacy string");
		});
	});
});

it("correct leading self-tag round-trips byte-identically through Pi storage and replay", () => {
	const reply =
		"§12§ Reading both files in parallel.\n\nThe next step follows.";
	const part = { type: "text", text: reply };
	const message = { role: "assistant", content: [part] };
	expect(stripTagPrefixFromAssistantMessage(message)).toBe(true);
	expect(prependTag(12, part.text)).toBe(reply);
});

describe("Oh My Pi assistant_message strip", () => {
	type Handler = (event: unknown) => { content: unknown[] } | undefined;
	function register(isActive = () => true): Handler {
		let handler: Handler | undefined;
		registerOmpAssistantMessageStrip(
			{
				on: (name: string, fn: Handler) => {
					if (name === "assistant_message") handler = fn;
				},
			},
			isActive,
		);
		if (!handler) throw new Error("assistant_message handler not registered");
		return handler;
	}

	it("returns text parts stripped by the message_end rule, in place, other fields kept", () => {
		const content = [
			{ type: "thinking", thinking: "§4§ reasoning" },
			{
				type: "text",
				text: "§42§ The pattern §40827§ appeared.",
				textSignature: "sig",
			},
			{ type: "toolCall", id: "t1", name: "read", arguments: {} },
		];
		const result = register()({
			type: "assistant_message",
			message: { role: "assistant", content },
		});
		expect(result?.content).toEqual([
			content[0],
			{
				type: "text",
				text: stripPersistedAssistantText(content[1].text as string),
				textSignature: "sig",
			},
			content[2],
		]);
		// Same rule and result as the in-place message_end strip used on stock Pi.
		const viaMessageEnd = {
			role: "assistant",
			content: structuredClone(content),
		};
		stripTagPrefixFromAssistantMessage(viaMessageEnd);
		expect(result?.content).toEqual(viaMessageEnd.content);
		// The event's message is left as it was.
		expect(content[1].text).toBe("§42§ The pattern §40827§ appeared.");
	});

	it("returns nothing when no text changes, for other roles, or when inactive", () => {
		const plain = {
			role: "assistant",
			content: [{ type: "text", text: "Plain reply" }],
		};
		expect(register()({ message: plain })).toBeUndefined();
		expect(
			register()({
				message: { role: "user", content: [{ type: "text", text: "§4§ hi" }] },
			}),
		).toBeUndefined();
		const tagged = {
			role: "assistant",
			content: [{ type: "text", text: "§4§ hi" }],
		};
		expect(register(() => false)({ message: tagged })).toBeUndefined();
		expect(register()(null)).toBeUndefined();
		expect(strippedAssistantContent("§4§ legacy string")).toBeUndefined();
	});
});
