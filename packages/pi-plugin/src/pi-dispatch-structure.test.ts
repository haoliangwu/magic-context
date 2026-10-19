import { expect, test } from "bun:test";
import {
	piMatchesPreparedStructure,
	piPreparedStructure,
} from "./pi-dispatch-structure";

const prepared = [
	{
		role: "user",
		content: "<session-history>managed</session-history>",
		timestamp: 1,
	},
	{
		role: "assistant",
		content: [
			{ type: "toolCall", id: "one", name: "Read", arguments: {} },
			{ type: "toolCall", id: "two", name: "Read", arguments: {} },
		],
		timestamp: 2,
	},
	{
		role: "toolResult",
		toolCallId: "one",
		content: [{ type: "text", text: "one" }],
		timestamp: 3,
	},
	{
		role: "toolResult",
		toolCallId: "two",
		content: [{ type: "text", text: "two" }],
		timestamp: 4,
	},
	{ role: "custom", content: "newest turn", timestamp: 5 },
];

const wire = {
	system: "system",
	messages: [
		{
			role: "user",
			content:
				"date/cwd reminder\n<session-history>redacted history</session-history>",
		},
		{
			role: "assistant",
			content: [
				{ type: "tool_use", id: "one", name: "Read", input: {} },
				{ type: "tool_use", id: "two", name: "Read", input: {} },
			],
		},
		{
			role: "user",
			content: [
				{ type: "tool_result", tool_use_id: "one", content: "PNG note" },
				{ type: "tool_result", tool_use_id: "two", content: "result" },
				{ type: "image", source: { data: "frame" } },
			],
		},
		{ role: "user", content: "wrapped newest turn" },
	],
};

function matches(payload: unknown) {
	return piMatchesPreparedStructure(payload, piPreparedStructure(prepared));
}

test("dispatch structure: text transforms and packed Anthropic result runs preserve every prepared turn", () => {
	expect(matches(wire)).toBe(true);
	expect(matches({ messages: prepared })).toBe(true);
});

test("dispatch structure: count and role order include the newest user turn", () => {
	expect(matches({ ...wire, messages: wire.messages.slice(0, -1) })).toBe(
		false,
	);
	const changed = structuredClone(wire);
	changed.messages[changed.messages.length - 1].role = "assistant";
	expect(matches(changed)).toBe(false);
});

test("dispatch structure: every tool call and result ID remains ordered", () => {
	for (const messageIndex of [1, 2]) {
		const changed = structuredClone(wire);
		(changed.messages[messageIndex].content as unknown[]).reverse();
		expect(matches(changed)).toBe(false);
	}
});

test("dispatch structure: a newest tool result with a different ID cannot establish first-send identity", () => {
	const current = prepared.slice(0, 4);
	const stale = structuredClone(current);
	stale[stale.length - 1].toolCallId = "prior-result";
	expect(
		piMatchesPreparedStructure(
			{ messages: stale },
			piPreparedStructure(current),
		),
	).toBe(false);
});

test("dispatch structure: preserved timestamps bind native message identities when present", () => {
	const changed = structuredClone(prepared);
	changed[changed.length - 1].timestamp = 0;
	expect(matches({ messages: changed })).toBe(false);
});

test("dispatch structure: Responses items reconstruct roles and compare call IDs without replay item IDs", () => {
	const payload = {
		input: [
			{ role: "user", content: "managed" },
			{ type: "reasoning", id: "r", encrypted_content: "reasoning" },
			{
				type: "message",
				role: "assistant",
				content: [{ type: "output_text", text: "working" }],
			},
			{
				type: "function_call",
				call_id: "one",
				id: "fc-one",
				name: "Read",
				arguments: "{}",
			},
			{ type: "function_call", call_id: "two", name: "Read", arguments: "{}" },
			{ type: "function_call_output", call_id: "one", output: "result" },
			{ type: "function_call_output", call_id: "two", output: "result" },
			{ role: "user", content: "newest turn" },
		],
	};
	expect(matches(payload)).toBe(true);
	payload.input[6].call_id = "prior-result";
	expect(matches(payload)).toBe(false);
});

test("dispatch structure: Responses string input represents exactly one user turn", () => {
	const single = piPreparedStructure([
		{ role: "user", content: "prepared", timestamp: 1 },
	]);
	expect(piMatchesPreparedStructure({ input: "prepared" }, single)).toBe(true);
	expect(matches({ input: "prepared" })).toBe(false);
});

test("dispatch structure: unknown or missing representations fail closed", () => {
	expect(matches({ contents: [] })).toBe(false);
	expect(matches({ messages: [{ role: "unknown" }] })).toBe(false);
	expect(piMatchesPreparedStructure(wire, undefined)).toBe(false);
});

test("dispatch structure: chat and Responses instruction messages are only an ordered leading prefix", () => {
	for (const role of ["system", "developer"]) {
		const prefix = [
			{ role, content: "First instruction" },
			{ role, content: "Second instruction" },
		];
		expect(matches({ messages: [...prefix, ...prepared] })).toBe(true);
		expect(matches({ input: [...prefix, ...prepared] })).toBe(true);
		expect(
			matches({
				messages: [prepared[0], ...prefix, ...prepared.slice(1)],
			}),
		).toBe(false);
	}
	expect(
		matches({
			input: [{ role: "system", content: "instruction" }, ...prepared],
		}),
	).toBe(true);
});
