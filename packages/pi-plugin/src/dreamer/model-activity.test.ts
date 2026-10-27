import { describe, expect, test } from "bun:test";
import { piEventShowsModelOutput } from "./model-activity";

describe("Pi and Oh My Pi model activity", () => {
	for (const type of [
		"text_delta",
		"thinking_delta",
		"toolcall_delta",
		"toolcall_start",
	]) {
		test(`${type} is model output before message_end`, () => {
			expect(
				piEventShowsModelOutput({
					type: "message_update",
					assistantMessageEvent: { type, delta: "x" },
				}),
			).toBe(true);
		});
	}
	test("startup, user input, errors and empty assistant envelopes are not output", () => {
		for (const event of [
			{ type: "agent_start" },
			{ type: "message_start", message: { role: "assistant", content: [] } },
			{
				type: "message_end",
				message: { role: "user", content: [{ type: "text", text: "prompt" }] },
			},
			{
				type: "message_end",
				message: { role: "assistant", content: [], errorMessage: "429" },
			},
			{
				type: "message_update",
				message: { role: "assistant", content: [] },
				assistantMessageEvent: { type: "start" },
			},
			{
				type: "message_update",
				message: { role: "assistant", content: [] },
				assistantMessageEvent: { type: "text_delta", delta: "" },
			},
		])
			expect(piEventShowsModelOutput(event)).toBe(false);
	});
	test("completed assistant content or usage is output on non-streaming providers", () => {
		for (const message of [
			{ content: [{ type: "text", text: " " }] },
			{ content: [{ type: "thinking", thinking: "reasoning" }] },
			{ content: [{ type: "toolCall", name: "read" }] },
			{ usage: { output: 1 } },
		])
			expect(
				piEventShowsModelOutput({
					type: "message_end",
					message: { role: "assistant", ...message },
				}),
			).toBe(true);
	});
});
