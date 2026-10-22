import { describe, expect, test } from "bun:test";
import {
	piPreparedStructure,
	piPreparedStructureMismatch,
} from "./pi-dispatch-structure";

// Issue 751: when a non-result message interrupts an open tool-call window,
// Oh My Pi's transformMessages moves the call's real result, found later in
// the history, into the window and drops it from its old position
// (@oh-my-pi/pi-ai src/providers/transform-messages.ts takeRealToolResult and
// flushPendingToolCalls). The prepared structure must put the result in the
// same slot, or the positional dispatch fence refuses a valid request.
// issue-751-host-oracle.test.ts checks these orders against the real host.

const codex = {
	id: "gpt-6.1-sol",
	api: "openai-codex-responses",
	provider: "openai-codex",
};
const chat = { id: "mock", api: "openai-completions", provider: "zen" };
type Model = typeof codex;

let clock = 0;
const user = (text: string) => ({
	role: "user",
	content: [{ type: "text", text }],
	timestamp: ++clock,
});
const custom = (text: string) => ({
	role: "custom",
	customType: "eval-state-context",
	content: text,
	display: false,
	attribution: "agent",
	timestamp: ++clock,
});
const developer = (text: string) => ({
	role: "developer",
	content: [{ type: "text", text }],
	timestamp: ++clock,
});
const call = (model: Model, ...ids: string[]) => ({
	role: "assistant",
	content: ids.map((id) => ({
		type: "toolCall",
		id,
		name: "wait",
		arguments: {},
	})),
	api: model.api,
	provider: model.provider,
	model: model.id,
	stopReason: "toolUse",
	timestamp: ++clock,
});
const result = (id: string, text = `done ${id}`) => ({
	role: "toolResult",
	toolCallId: id,
	toolName: "wait",
	content: [{ type: "text", text }],
	isError: false,
	timestamp: ++clock,
});

/** One wire row: a user-visible message, an assistant's calls, or one result. */
type Row =
	| { user: string; role?: "user" | "developer" }
	| { calls: string[] }
	| { result: string; output?: string };

function responsesPayload(model: Model, rows: Row[]) {
	return {
		model: model.id,
		input: rows.flatMap((row) =>
			"user" in row
				? [
						{
							type: "message",
							role: row.role ?? "user",
							content: [{ type: "input_text", text: row.user }],
						},
					]
				: "calls" in row
					? row.calls.map((id) => ({
							type: "function_call",
							call_id: id,
							name: "wait",
							arguments: "{}",
						}))
					: [
							{
								type: "function_call_output",
								call_id: row.result,
								output: row.output ?? `done ${row.result}`,
							},
						],
		),
	};
}

function chatPayload(rows: Row[]) {
	return {
		model: chat.id,
		messages: rows.map((row) =>
			"user" in row
				? { role: row.role ?? "user", content: row.user }
				: "calls" in row
					? {
							role: "assistant",
							content: null,
							tool_calls: row.calls.map((id) => ({
								type: "function",
								id,
								function: { name: "wait", arguments: "{}" },
							})),
						}
					: {
							role: "tool",
							tool_call_id: row.result,
							content: row.output ?? `done ${row.result}`,
						},
		),
	};
}

interface Case {
	name: string;
	history: (model: Model) => unknown[];
	/** What the host sends. */
	wire: Row[];
	/** The same rows left where the history had them, which the fence must refuse. */
	unmoved?: Row[];
}

const NOTICE = "<system-reminder>state</system-reminder>";
const cases: Case[] = [
	{
		name: "a custom notice between the call and its result",
		history: (model) => [
			user("go"),
			call(model, "call_X"),
			custom(NOTICE),
			result("call_X", "done"),
		],
		wire: [
			{ user: "go" },
			{ calls: ["call_X"] },
			{ result: "call_X", output: "done" },
			{ user: NOTICE },
		],
		unmoved: [
			{ user: "go" },
			{ calls: ["call_X"] },
			{ user: NOTICE },
			{ result: "call_X", output: "done" },
		],
	},
	{
		name: "a plain user message between the call and its result",
		history: (model) => [
			user("go"),
			call(model, "call_X"),
			user("interjection"),
			result("call_X"),
		],
		wire: [
			{ user: "go" },
			{ calls: ["call_X"] },
			{ result: "call_X" },
			{ user: "interjection" },
		],
		unmoved: [
			{ user: "go" },
			{ calls: ["call_X"] },
			{ user: "interjection" },
			{ result: "call_X" },
		],
	},
	{
		name: "a developer message between the call and its result",
		history: (model) => [
			user("go"),
			call(model, "call_X"),
			developer("late diagnostic"),
			result("call_X"),
		],
		wire: [
			{ user: "go" },
			{ calls: ["call_X"] },
			{ result: "call_X" },
			{ user: "late diagnostic", role: "developer" },
		],
		unmoved: [
			{ user: "go" },
			{ calls: ["call_X"] },
			{ user: "late diagnostic", role: "developer" },
			{ result: "call_X" },
		],
	},
	{
		name: "two interrupting messages",
		history: (model) => [
			user("go"),
			call(model, "call_X"),
			custom(NOTICE),
			user("interjection"),
			result("call_X"),
		],
		wire: [
			{ user: "go" },
			{ calls: ["call_X"] },
			{ result: "call_X" },
			{ user: NOTICE },
			{ user: "interjection" },
		],
		unmoved: [
			{ user: "go" },
			{ calls: ["call_X"] },
			{ user: NOTICE },
			{ user: "interjection" },
			{ result: "call_X" },
		],
	},
	{
		// The window takes each call's result in call order, not arrival order.
		name: "two open calls whose results arrive in swapped order",
		history: (model) => [
			user("go"),
			call(model, "call_A", "call_B"),
			custom(NOTICE),
			result("call_B"),
			result("call_A"),
		],
		wire: [
			{ user: "go" },
			{ calls: ["call_A", "call_B"] },
			{ result: "call_A" },
			{ result: "call_B" },
			{ user: NOTICE },
		],
		unmoved: [
			{ user: "go" },
			{ calls: ["call_A", "call_B"] },
			{ user: NOTICE },
			{ result: "call_B" },
			{ result: "call_A" },
		],
	},
	{
		name: "a result that never arrives gets the host's stub",
		history: (model) => [user("go"), call(model, "call_X"), custom(NOTICE)],
		wire: [
			{ user: "go" },
			{ calls: ["call_X"] },
			{ result: "call_X", output: "No result provided" },
			{ user: NOTICE },
		],
	},
	{
		name: "control: a result right after its call",
		history: (model) => [
			user("go"),
			call(model, "call_X"),
			result("call_X"),
			custom(NOTICE),
		],
		wire: [
			{ user: "go" },
			{ calls: ["call_X"] },
			{ result: "call_X" },
			{ user: NOTICE },
		],
	},
];

describe("issue 751: a tool result moved forward across an interrupting message", () => {
	for (const item of cases) {
		test(`Responses lane: ${item.name}`, () => {
			const prepared = piPreparedStructure(item.history(codex), codex);
			expect(prepared?.responsesMessages).toBeDefined();
			expect(
				piPreparedStructureMismatch(
					responsesPayload(codex, item.wire),
					prepared,
				),
			).toBeUndefined();
			if (item.unmoved)
				expect(
					piPreparedStructureMismatch(
						responsesPayload(codex, item.unmoved),
						prepared,
					),
				).toContain("comparison=");
		});
		test(`chat-completions lane: ${item.name}`, () => {
			const prepared = piPreparedStructure(item.history(chat), chat);
			expect(prepared?.chatMessages).toBeDefined();
			expect(
				piPreparedStructureMismatch(chatPayload(item.wire), prepared),
			).toBeUndefined();
			if (item.unmoved)
				expect(
					piPreparedStructureMismatch(chatPayload(item.unmoved), prepared),
				).toContain("comparison=");
		});
	}

	test("the reporter's prepared rows put the real result in the window", () => {
		const prepared = piPreparedStructure(cases[0].history(codex), codex);
		expect(
			prepared?.responsesMessages?.map((row) => [
				row.role,
				row.calls.length,
				row.results.length,
			]),
		).toEqual([
			["user", 0, 0],
			["assistant", 1, 0],
			["toolResult", 0, 1],
			["user", 0, 0],
		]);
	});

	test("a moved result is never also a stale-tool-result note on the chat lane", () => {
		// A Responses-family call answered by a composite result with another
		// item half pairs by its call_id component, so the result is that call's
		// even after the chat model takes over the session.
		const responses = { ...codex, api: "openai-responses" };
		const history = [
			user("go"),
			call(responses, "call_X|fc_call"),
			custom(NOTICE),
			result("call_X|fc_result"),
		];
		const prepared = piPreparedStructure(history, chat);
		expect(prepared?.chatMessages).toBeDefined();
		expect(
			prepared?.chatMessages?.some((row) => row.exactText !== undefined),
		).toBe(false);
		expect(
			prepared?.chatMessages?.map((row) => [row.role, row.results]),
		).toEqual([
			["user", []],
			["assistant", []],
			["toolResult", ["call_X|fc_result"]],
			["user", []],
		]);
		expect(
			piPreparedStructureMismatch(
				chatPayload([
					{ user: "go" },
					{ calls: ["call_X"] },
					{ result: "call_X" },
					{ user: NOTICE },
				]),
				prepared,
			),
		).toBeUndefined();
	});
});
