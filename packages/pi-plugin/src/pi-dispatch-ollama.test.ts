import { expect, test } from "bun:test";
import {
	piMatchesPreparedStructure,
	piPreparedStructure,
} from "./pi-dispatch-structure";

const model = { api: "ollama-chat" };
const prepared = piPreparedStructure(
	[
		{
			role: "user",
			content: "<session-history>managed</session-history>",
			timestamp: 1,
		},
		{
			role: "assistant",
			content: [
				{ type: "toolCall", id: "one", name: "Read", arguments: {} },
				{ type: "toolCall", id: "two", name: "Write", arguments: {} },
			],
			timestamp: 2,
		},
		{
			role: "toolResult",
			toolCallId: "one",
			toolName: "Read",
			content: [{ type: "text", text: "one" }],
			timestamp: 3,
		},
		{
			role: "toolResult",
			toolCallId: "two",
			toolName: "Write",
			content: [{ type: "text", text: "two" }],
			timestamp: 4,
		},
		{ role: "user", content: "latest", timestamp: 5 },
	],
	model,
);
function payload() {
	return {
		messages: [
			{ role: "user", content: "<session-history>managed</session-history>" },
			{
				role: "assistant",
				content: "",
				tool_calls: [
					{ type: "function", function: { name: "Read", arguments: {} } },
					{ type: "function", function: { name: "Write", arguments: {} } },
				],
			},
			{ role: "tool", tool_name: "Read", content: "one" },
			{ role: "tool", tool_name: "Write", content: "two" },
			{ role: "user", content: "latest" },
		],
	};
}

function getPrepared() {
	if (!prepared) throw new Error("expected prepared tool history");
	return prepared;
}
function calls(body: ReturnType<typeof payload>) {
	const result = body.messages[1].tool_calls;
	if (!result) throw new Error("expected fixture calls");
	return result;
}

test("Ollama equivalence: native ID-less tool history binds ordered call and answer names", () => {
	expect(piMatchesPreparedStructure(payload(), prepared)).toBe(true);
	expect(
		piMatchesPreparedStructure(payload(), {
			...getPrepared(),
			api: "openai-completions",
		}),
	).toBe(false);
});
test("Ollama equivalence: swapped call order refuses", () => {
	const changed = payload();
	calls(changed).reverse();
	expect(piMatchesPreparedStructure(changed, prepared)).toBe(false);
});
test("Ollama equivalence: renamed call or answer refuses", () => {
	const call = payload();
	calls(call)[0].function.name = "Renamed";
	expect(piMatchesPreparedStructure(call, prepared)).toBe(false);
	const result = payload();
	result.messages[2].tool_name = "Renamed";
	expect(piMatchesPreparedStructure(result, prepared)).toBe(false);
});
test("Ollama equivalence: extra result refuses", () => {
	const changed = payload();
	changed.messages.splice(4, 0, {
		role: "tool",
		tool_name: "Write",
		content: "extra",
	});
	expect(piMatchesPreparedStructure(changed, prepared)).toBe(false);
});
test("Ollama equivalence: present IDs remain strict including empty IDs", () => {
	for (const id of ["wrong", ""]) {
		const changed = payload();
		Object.assign(calls(changed)[0], { id });
		expect(piMatchesPreparedStructure(changed, prepared)).toBe(false);
		const result = payload();
		Object.assign(result.messages[2], { tool_call_id: id });
		expect(piMatchesPreparedStructure(result, prepared)).toBe(false);
	}
	const exact = payload();
	Object.assign(calls(exact)[0], { id: "one" });
	Object.assign(calls(exact)[1], { id: "two" });
	Object.assign(exact.messages[2], { tool_call_id: "one" });
	Object.assign(exact.messages[3], { tool_call_id: "two" });
	expect(piMatchesPreparedStructure(exact, prepared)).toBe(true);
});
