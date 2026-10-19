import { expect, test } from "bun:test";
import {
	piMatchesPreparedStructure,
	piPreparedStructure,
} from "./pi-dispatch-structure";

const call = {
	role: "assistant",
	content: [
		{ type: "toolCall", id: "done", name: "Read", arguments: {} },
		{ type: "toolCall", id: "pending", name: "Read", arguments: {} },
	],
	stopReason: "toolUse",
	timestamp: 2,
};
const realResult = {
	role: "toolResult",
	toolCallId: "done",
	toolName: "Read",
	content: [{ type: "text", text: "real result" }],
	timestamp: 3,
};
const history = [
	{ role: "user", content: "managed history", timestamp: 1 },
	call,
	realResult,
	{ role: "user", content: "next turn", timestamp: 4 },
];
interface Payload {
	input?: Record<string, unknown>[];
	messages?: Record<string, unknown>[];
	system?: string;
}
const fixtures: { api: string; payload: Payload }[] = [
	{
		api: "openai-responses",
		payload: {
			input: [
				{ role: "user", content: "managed history" },
				{
					type: "function_call",
					call_id: "done",
					name: "Read",
					arguments: "{}",
				},
				{
					type: "function_call",
					call_id: "pending",
					name: "Read",
					arguments: "{}",
				},
				{
					type: "function_call_output",
					call_id: "done",
					output: "real result",
				},
				{
					type: "function_call_output",
					call_id: "pending",
					output: "No result provided",
				},
				{ role: "user", content: "next turn" },
			],
		},
	},
	{
		api: "openai-completions",
		payload: {
			messages: [
				{ role: "user", content: "managed history" },
				{
					role: "assistant",
					content: null,
					tool_calls: [
						{
							type: "function",
							id: "done",
							function: { name: "Read", arguments: "{}" },
						},
						{
							type: "function",
							id: "pending",
							function: { name: "Read", arguments: "{}" },
						},
					],
				},
				{ role: "tool", tool_call_id: "done", content: "real result" },
				{
					role: "tool",
					tool_call_id: "pending",
					content: "No result provided",
				},
				{ role: "user", content: "next turn" },
			],
		},
	},
	{
		api: "anthropic-messages",
		payload: {
			system: "instructions",
			messages: [
				{ role: "user", content: "managed history" },
				{
					role: "assistant",
					content: [
						{ type: "tool_use", id: "done", name: "Read", input: {} },
						{ type: "tool_use", id: "pending", name: "Read", input: {} },
					],
				},
				{
					role: "user",
					content: [
						{
							type: "tool_result",
							tool_use_id: "done",
							content: "real result",
						},
						{
							type: "tool_result",
							tool_use_id: "pending",
							content: "No result provided",
							is_error: true,
						},
					],
				},
				{ role: "user", content: "next turn" },
			],
		},
	},
];

function withExtraResult(payload: Payload, id: string): Payload {
	const extra = structuredClone(payload);
	const rows = extra.input ?? extra.messages;
	if (!rows) throw new Error("fixture needs conversation rows");
	rows.splice(
		-1,
		0,
		extra.input
			? {
					type: "function_call_output",
					call_id: id,
					output: "No result provided",
				}
			: extra.system
				? {
						role: "user",
						content: [
							{
								type: "tool_result",
								tool_use_id: id,
								content: "No result provided",
								is_error: true,
							},
						],
					}
				: { role: "tool", tool_call_id: id, content: "No result provided" },
	);
	return extra;
}

for (const { api, payload } of fixtures) {
	test(`dispatch interrupted tool: ${api} admits only the missing result projection`, () => {
		const snapshot = piPreparedStructure(history, { api });
		expect(piMatchesPreparedStructure(payload, snapshot)).toBe(true);
		expect(
			piMatchesPreparedStructure(
				withExtraResult(payload, "unexpected"),
				snapshot,
			),
		).toBe(false);
		expect(
			piMatchesPreparedStructure(withExtraResult(payload, "pending"), snapshot),
		).toBe(false);
	});
}

test("dispatch interrupted tool: historical boundaries and EOF both synthesize results", () => {
	const oldCall = { ...call, content: [call.content[0]] };
	const latest = {
		...call,
		content: [call.content[1]],
		stopReason: "stop",
		timestamp: 10,
	};
	const original = [history[0], oldCall, latest];
	const before = JSON.stringify(original);
	const snapshot = piPreparedStructure(original);
	expect(snapshot?.messages.map((row) => [row.role, row.results])).toEqual([
		["user", []],
		["assistant", []],
		["toolResult", ["done"]],
		["assistant", []],
		["toolResult", ["pending"]],
	]);
	expect(snapshot?.messages[2].timestamp).toBe(10);
	expect(JSON.stringify(original)).toBe(before);
});

test("dispatch interrupted tool: aborted and error calls use the assistant timestamp", () => {
	for (const stopReason of ["aborted", "error"]) {
		const snapshot = piPreparedStructure([
			history[0],
			{ ...call, stopReason },
			realResult,
			history[3],
		]);
		expect(snapshot?.messages.map((row) => row.results)).toEqual([
			[],
			[],
			["done"],
			["pending"],
			[],
		]);
		expect(snapshot?.messages[3].timestamp).toBe(2);
	}
});

test("dispatch interrupted tool: a real result prevents synthesis even after a boundary", () => {
	const snapshot = piPreparedStructure([
		history[0],
		call,
		history[3],
		realResult,
		{ ...realResult, toolCallId: "pending" },
	]);
	expect(snapshot?.messages.map((row) => row.role)).toEqual([
		"user",
		"assistant",
		"user",
		"toolResult",
		"toolResult",
	]);
	const moved = {
		messages: [
			history[0],
			call,
			realResult,
			{ ...realResult, toolCallId: "pending" },
			history[3],
		],
	};
	expect(piMatchesPreparedStructure(moved, snapshot)).toBe(false);
});

test("dispatch interrupted tool: complete arcs cannot borrow an extra synthesized row", () => {
	const complete = [
		history[0],
		call,
		realResult,
		{ ...realResult, toolCallId: "pending" },
		history[3],
	];
	const extra = {
		messages: [
			...complete.slice(0, -1),
			{ ...realResult, toolCallId: "pending" },
			complete.at(-1),
		],
	};
	expect(piMatchesPreparedStructure(extra, piPreparedStructure(complete))).toBe(
		false,
	);
});

test("dispatch interrupted tool: Responses item suffixes cannot manufacture a missing result", () => {
	const source = [
		history[0],
		{
			...call,
			api: "openai-responses",
			content: [{ ...call.content[0], id: "done|fc_call" }],
		},
		{ ...realResult, toolCallId: "done|fc_result" },
		history[3],
	];
	const snapshot = piPreparedStructure(source, { api: "openai-responses" });
	expect(snapshot?.messages.map((row) => row.role)).toEqual([
		"user",
		"assistant",
		"toolResult",
		"user",
	]);
	expect(
		piMatchesPreparedStructure(
			{
				input: [
					{ role: "user", content: "managed history" },
					{
						type: "function_call",
						call_id: "done",
						name: "Read",
						arguments: "{}",
					},
					{
						type: "function_call_output",
						call_id: "done",
						output: "real result",
					},
					{ role: "user", content: "next turn" },
				],
			},
			snapshot,
		),
	).toBe(true);
});

test("dispatch interrupted tool: opaque Chat IDs with a shared Responses prefix remain distinct", () => {
	const source = [
		history[0],
		{ ...call, api: "openai-responses", content: [call.content[0]] },
		realResult,
		{
			...call,
			api: "openai-completions",
			content: [
				{ ...call.content[0], id: "done|first" },
				{ ...call.content[0], id: "done|second" },
			],
		},
		{ ...realResult, toolCallId: "done|second" },
		history[3],
	];
	const snapshot = piPreparedStructure(source);
	expect(snapshot?.messages.map((row) => row.results)).toEqual([
		[],
		[],
		["done"],
		[],
		["done|second"],
		["done|first"],
		[],
	]);
});
