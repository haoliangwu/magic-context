import { expect, test } from "bun:test";
import { piPreparedStructure } from "./pi-dispatch-structure";

// Oh My Pi's cursor-agent and gitlab-duo-agent providers do not run
// transformMessages, and an extension's custom API is unknown. Because the
// host's move of a later tool result into an interrupted call's window is not
// known for them, their prepared structure must stay exactly what it was before
// that move was modeled. Each expected string below is JSON.stringify of
// piPreparedStructure on the same history at commit 0377778106, so any drift
// from that behavior fails here.

const tool = (id: string) => ({
	type: "toolCall",
	id,
	name: "wait",
	arguments: {},
});
const result = (id: string, timestamp: number) => ({
	role: "toolResult",
	toolCallId: id,
	toolName: "wait",
	content: [{ type: "text", text: `done ${id}` }],
	isError: false,
	timestamp,
});
const assistant = (
	api: string,
	timestamp: number,
	stopReason: string,
	...ids: string[]
) => ({
	role: "assistant",
	api,
	provider: "custom",
	model: "m",
	content: ids.map(tool),
	stopReason,
	timestamp,
});

/**
 * Interrupted windows with late, swapped, early and duplicate results, and an
 * aborted turn whose result never arrives.
 */
const history = (api: string) => [
	{ role: "user", content: [{ type: "text", text: "go" }], timestamp: 1 },
	assistant(api, 2, "toolUse", "call_A", "call_B"),
	{
		role: "custom",
		customType: "eval-state-context",
		content: "notice",
		display: false,
		attribution: "agent",
		timestamp: 3,
	},
	result("call_B", 4),
	{
		role: "user",
		content: [{ type: "text", text: "interjection" }],
		timestamp: 5,
	},
	result("call_A", 6),
	assistant(api, 7, "aborted", "call_C"),
	result("call_D", 8),
	assistant(api, 9, "toolUse", "call_D", "call_E"),
	result("call_A", 10),
	{
		role: "developer",
		content: [{ type: "text", text: "late diagnostic" }],
		timestamp: 11,
	},
	result("call_E", 12),
];

const before: [string | undefined, string][] = [
	[
		undefined,
		'{"messages":[{"role":"user","calls":[],"results":[],"timestamp":1},{"role":"assistant","calls":["call_A","call_B"],"results":[],"timestamp":2,"callNames":["wait","wait"]},{"role":"user","calls":[],"results":[],"timestamp":3},{"role":"toolResult","calls":[],"results":["call_B"],"timestamp":4,"resultNames":["wait"]},{"role":"user","calls":[],"results":[],"timestamp":5},{"role":"toolResult","calls":[],"results":["call_A"],"timestamp":6,"resultNames":["wait"]},{"role":"assistant","calls":["call_C"],"results":[],"timestamp":7,"callNames":["wait"]},{"role":"toolResult","calls":[],"results":["call_D"],"timestamp":8,"resultNames":[""]},{"role":"toolResult","calls":[],"results":["call_C"],"timestamp":7,"resultNames":["wait"]},{"role":"assistant","calls":["call_D","call_E"],"results":[],"timestamp":9,"callNames":["wait","wait"]},{"role":"toolResult","calls":[],"results":["call_A"],"timestamp":10,"resultNames":["wait"]},{"role":"toolResult","calls":[],"results":["call_D"],"timestamp":11,"resultNames":["wait"]},{"role":"user","calls":[],"results":[],"timestamp":11},{"role":"toolResult","calls":[],"results":["call_E"],"timestamp":12,"resultNames":["wait"]}]}',
	],
	[
		"cursor-agent",
		'{"messages":[{"role":"user","calls":[],"results":[],"timestamp":1},{"role":"assistant","calls":["call_A","call_B"],"results":[],"timestamp":2,"callNames":["wait","wait"],"wireCalls":["call_A","call_B"]},{"role":"user","calls":[],"results":[],"timestamp":3},{"role":"toolResult","calls":[],"results":["call_B"],"timestamp":4,"resultNames":["wait"],"wireResults":["call_B"]},{"role":"user","calls":[],"results":[],"timestamp":5},{"role":"toolResult","calls":[],"results":["call_A"],"timestamp":6,"resultNames":["wait"],"wireResults":["call_A"]},{"role":"assistant","calls":["call_C"],"results":[],"timestamp":7,"callNames":["wait"],"wireCalls":["call_C"]},{"role":"toolResult","calls":[],"results":["call_D"],"timestamp":8,"resultNames":[""],"wireResults":[null]},{"role":"toolResult","calls":[],"results":["call_C"],"timestamp":7,"resultNames":["wait"],"wireResults":["call_C"]},{"role":"assistant","calls":["call_D","call_E"],"results":[],"timestamp":9,"callNames":["wait","wait"],"wireCalls":["call_D","call_E"]},{"role":"toolResult","calls":[],"results":["call_A"],"timestamp":10,"resultNames":["wait"],"wireResults":["call_A"]},{"role":"toolResult","calls":[],"results":["call_D"],"timestamp":11,"resultNames":["wait"],"wireResults":["call_D"]},{"role":"user","calls":[],"results":[],"timestamp":11},{"role":"toolResult","calls":[],"results":["call_E"],"timestamp":12,"resultNames":["wait"],"wireResults":["call_E"]}],"api":"cursor-agent"}',
	],
	[
		"gitlab-duo-agent",
		'{"messages":[{"role":"user","calls":[],"results":[],"timestamp":1},{"role":"assistant","calls":["call_A","call_B"],"results":[],"timestamp":2,"callNames":["wait","wait"],"wireCalls":["call_A","call_B"]},{"role":"user","calls":[],"results":[],"timestamp":3},{"role":"toolResult","calls":[],"results":["call_B"],"timestamp":4,"resultNames":["wait"],"wireResults":["call_B"]},{"role":"user","calls":[],"results":[],"timestamp":5},{"role":"toolResult","calls":[],"results":["call_A"],"timestamp":6,"resultNames":["wait"],"wireResults":["call_A"]},{"role":"assistant","calls":["call_C"],"results":[],"timestamp":7,"callNames":["wait"],"wireCalls":["call_C"]},{"role":"toolResult","calls":[],"results":["call_D"],"timestamp":8,"resultNames":[""],"wireResults":[null]},{"role":"toolResult","calls":[],"results":["call_C"],"timestamp":7,"resultNames":["wait"],"wireResults":["call_C"]},{"role":"assistant","calls":["call_D","call_E"],"results":[],"timestamp":9,"callNames":["wait","wait"],"wireCalls":["call_D","call_E"]},{"role":"toolResult","calls":[],"results":["call_A"],"timestamp":10,"resultNames":["wait"],"wireResults":["call_A"]},{"role":"toolResult","calls":[],"results":["call_D"],"timestamp":11,"resultNames":["wait"],"wireResults":["call_D"]},{"role":"user","calls":[],"results":[],"timestamp":11},{"role":"toolResult","calls":[],"results":["call_E"],"timestamp":12,"resultNames":["wait"],"wireResults":["call_E"]}],"api":"gitlab-duo-agent"}',
	],
	[
		"vertex-claude-api",
		'{"messages":[{"role":"user","calls":[],"results":[],"timestamp":1},{"role":"assistant","calls":["call_A","call_B"],"results":[],"timestamp":2,"callNames":["wait","wait"],"wireCalls":["call_A","call_B"]},{"role":"user","calls":[],"results":[],"timestamp":3},{"role":"toolResult","calls":[],"results":["call_B"],"timestamp":4,"resultNames":["wait"],"wireResults":["call_B"]},{"role":"user","calls":[],"results":[],"timestamp":5},{"role":"toolResult","calls":[],"results":["call_A"],"timestamp":6,"resultNames":["wait"],"wireResults":["call_A"]},{"role":"assistant","calls":["call_C"],"results":[],"timestamp":7,"callNames":["wait"],"wireCalls":["call_C"]},{"role":"toolResult","calls":[],"results":["call_D"],"timestamp":8,"resultNames":[""],"wireResults":[null]},{"role":"toolResult","calls":[],"results":["call_C"],"timestamp":7,"resultNames":["wait"],"wireResults":["call_C"]},{"role":"assistant","calls":["call_D","call_E"],"results":[],"timestamp":9,"callNames":["wait","wait"],"wireCalls":["call_D","call_E"]},{"role":"toolResult","calls":[],"results":["call_A"],"timestamp":10,"resultNames":["wait"],"wireResults":["call_A"]},{"role":"toolResult","calls":[],"results":["call_D"],"timestamp":11,"resultNames":["wait"],"wireResults":["call_D"]},{"role":"user","calls":[],"results":[],"timestamp":11},{"role":"toolResult","calls":[],"results":["call_E"],"timestamp":12,"resultNames":["wait"],"wireResults":["call_E"]}],"api":"vertex-claude-api"}',
	],
];

for (const [api, expected] of before) {
	test(`unmodeled API ${api ?? "(no model)"}: interrupted-call rows are unchanged from before the forward pull`, () => {
		const model = api ? { api, provider: "custom", id: "m" } : undefined;
		expect(
			JSON.stringify(piPreparedStructure(history(api ?? "custom-api"), model)),
		).toBe(expected);
	});
}

test("the same history does move results on an API that runs transformMessages", () => {
	// Guards the fixture: if this history had nothing to move, the snapshots
	// above could not tell the two projections apart. These rows are what the
	// real @oh-my-pi/pi-ai 18.12.3 transformMessages emits for this history.
	const model = { api: "anthropic-messages", provider: "custom", id: "m" };
	const modeled = piPreparedStructure(history(model.api), model);
	const unmodeled = piPreparedStructure(history(model.api), {
		...model,
		api: "cursor-agent",
	});
	expect(modeled?.messages.map((row) => [row.role, row.results])).not.toEqual(
		unmodeled?.messages.map((row) => [row.role, row.results]),
	);
	expect(modeled?.messages.map((row) => [row.role, row.results])).toEqual([
		["user", []],
		["assistant", []],
		["toolResult", ["call_A"]],
		["toolResult", ["call_B"]],
		["user", []],
		["user", []],
		["assistant", []],
		["toolResult", ["call_C"]],
		["assistant", []],
		["toolResult", ["call_D"]],
		["toolResult", ["call_E"]],
		["user", []],
	]);
});
