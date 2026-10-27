import { expect, test } from "bun:test";
import {
	piPreparedStructure,
	piPreparedStructureMismatch,
} from "./pi-dispatch-structure";

// Issue 785: Oh My Pi's Anthropic provider inserts request-control system
// messages (tool_addition/tool_removal blocks, or an effort-only control with
// empty content and its effort in output_config) after the context pass. They
// are not prepared turns, so the dispatch check must not count them as
// conversation rows, wherever they sit in the request.

const anthropic = {
	api: "anthropic-messages",
	compat: { supportsMidConversationSystem: true },
	input: ["text", "image"],
};
const head = { role: "user", content: "managed history", timestamp: 1 };
const prompt = { role: "user", content: "current request", timestamp: 4 };
const prepared = piPreparedStructure(
	[
		head,
		{
			role: "assistant",
			content: [{ type: "toolCall", id: "one", name: "read", arguments: {} }],
			timestamp: 2,
		},
		{
			role: "toolResult",
			toolCallId: "one",
			toolName: "read",
			content: [{ type: "text", text: "body" }],
			timestamp: 3,
		},
		prompt,
	],
	anthropic,
);
const wire = [
	head,
	{
		role: "assistant",
		content: [{ type: "tool_use", id: "one", name: "read", input: {} }],
	},
	{
		role: "user",
		content: [{ type: "tool_result", tool_use_id: "one", content: "body" }],
	},
	prompt,
];
const control = (type: string, name: string) => ({
	type,
	tool: { type: "tool_reference", name },
});

test("issue 785: trailing request-control system rows are not prepared turns", () => {
	expect(
		piPreparedStructureMismatch({ messages: wire }, prepared),
	).toBeUndefined();
	for (const content of [
		[control("tool_addition", "x")],
		[control("tool_addition", "x"), control("tool_removal", "y")],
		[],
	])
		expect(
			piPreparedStructureMismatch(
				{ messages: [...wire, { role: "system", content }] },
				prepared,
			),
		).toBeUndefined();
});

test("issue 785: request controls inside the conversation are not prepared turns", () => {
	const effortOnly = {
		role: "system",
		content: [],
		output_config: { effort: "high" },
	};
	const toolControl = {
		role: "system",
		content: [control("tool_addition", "x")],
	};
	// Oh My Pi replays a recorded control before the earlier response it came
	// with, and puts an effort-only control before the turn's user message.
	for (const messages of [
		[wire[0], toolControl, ...wire.slice(1)],
		[...wire.slice(0, 3), effortOnly, wire[3]],
		[...wire, effortOnly],
	])
		expect(piPreparedStructureMismatch({ messages }, prepared)).toBeUndefined();
});

test("issue 785: unprepared system text rows still refuse", () => {
	for (const content of [
		"unprepared instructions",
		[{ type: "text", text: "unprepared instructions" }],
		[control("tool_addition", "x"), { type: "text", text: "unprepared" }],
	]) {
		expect(
			piPreparedStructureMismatch(
				{ messages: [...wire, { role: "system", content }] },
				prepared,
			),
		).toContain("comparison=count");
		expect(
			piPreparedStructureMismatch(
				{
					messages: [
						...wire.slice(0, 3),
						{ role: "system", content },
						...wire.slice(3),
					],
				},
				prepared,
			),
		).toContain("comparison=");
	}
});
