import { expect, test } from "bun:test";
import type { PiChatHistoryModel } from "./pi-dispatch-chat-history";
import {
	piMatchesPreparedStructure,
	piPreparedStructure,
} from "./pi-dispatch-structure";

const composite =
	"call_01a1361b403f7560bacf986beb38cbcc|fc_01a1361b403f7560bacf986beb38cbcc";
const callId = "call_01a1361b403f7560bacf986beb38cbcc";
const sanitized =
	"call_01a1361b403f7560bacf986beb38cbcc_fc_01a1361b403f7560bacf986";
const target = (api: string, compat: object = {}): PiChatHistoryModel => ({
	api,
	provider: "mock",
	id: "target",
	compat,
});
const sameSource = (model: PiChatHistoryModel) => ({
	api: model.api,
	provider: model.provider,
	model: model.id,
});
const foreign = {
	api: "openai-responses",
	provider: "history",
	model: "previous",
};

function history(id: string, source: object) {
	return [
		{ role: "user", content: [{ type: "text", text: "before" }], timestamp: 1 },
		{
			role: "assistant",
			...source,
			content: [{ type: "toolCall", id, name: "Read", arguments: {} }],
			timestamp: 2,
		},
		{
			role: "toolResult",
			toolCallId: id,
			toolName: "Read",
			content: [{ type: "text", text: "answer" }],
			timestamp: 3,
		},
		{ role: "user", content: [{ type: "text", text: "now" }], timestamp: 4 },
	];
}

function payload(
	api: string,
	call: string,
	result = call,
	ids = true,
): unknown {
	if (api.includes("responses"))
		return {
			input: [
				{ role: "user", content: "before" },
				{ type: "function_call", call_id: call, name: "Read", arguments: "{}" },
				{ type: "function_call_output", call_id: result, output: "answer" },
				{ role: "user", content: "now" },
			],
		};
	if (api.startsWith("google-"))
		return {
			contents: [
				{ role: "user", parts: [{ text: "before" }] },
				{
					role: "model",
					parts: [
						{
							functionCall: {
								...(ids ? { id: call } : {}),
								name: "Read",
								args: {},
							},
						},
					],
				},
				{
					role: "user",
					parts: [
						{
							functionResponse: {
								...(ids ? { id: result } : {}),
								name: "Read",
								response: { output: "answer" },
							},
						},
					],
				},
				{ role: "user", parts: [{ text: "now" }] },
			],
		};
	if (api === "anthropic-messages" || api === "bedrock-converse-stream") {
		const bedrock = api === "bedrock-converse-stream";
		return {
			...(bedrock
				? { inferenceConfig: {} }
				: { max_tokens: 100, system: [{ type: "text", text: "system" }] }),
			messages: [
				{ role: "user", content: [{ type: "text", text: "before" }] },
				{
					role: "assistant",
					content: [
						bedrock
							? { toolUse: { toolUseId: call, name: "Read", input: {} } }
							: { type: "tool_use", id: call, name: "Read", input: {} },
					],
				},
				{
					role: "user",
					content: [
						bedrock
							? {
									toolResult: {
										toolUseId: result,
										content: [{ text: "answer" }],
									},
								}
							: { type: "tool_result", tool_use_id: result, content: "answer" },
					],
				},
				{ role: "user", content: [{ type: "text", text: "now" }] },
			],
		};
	}
	// A top-level system string can accompany Chat Completions messages. It
	// must not select Anthropic's ID rules in place of the request model's API.
	return {
		system: "system",
		messages: [
			{ role: "user", content: "before" },
			{
				role: "assistant",
				content: null,
				tool_calls: [
					{
						id: call,
						type: "function",
						function: { name: "Read", arguments: "{}" },
					},
				],
			},
			{ role: "tool", tool_call_id: result, content: "answer" },
			{ role: "user", content: "now" },
		],
	};
}

function check(
	model: PiChatHistoryModel,
	id: string,
	source: object,
	expected: string,
) {
	if (!model.api) throw new Error("test requires a target API");
	const prepared = piPreparedStructure(history(id, source), model);
	expect(prepared).toBeDefined();
	expect(
		piMatchesPreparedStructure(payload(model.api, expected), prepared),
	).toBe(true);
	expect(
		piMatchesPreparedStructure(
			payload(model.api, `${expected}_wrong`, expected),
			prepared,
		),
	).toBe(false);
	expect(
		piMatchesPreparedStructure(
			payload(model.api, expected, `${expected}_wrong`),
			prepared,
		),
	).toBe(false);
}

test("tool ID table: openai-completions", () => {
	const model = target("openai-completions");
	check(model, composite, foreign, callId);
	check(model, composite, sameSource(model), composite);
	check(model, `a.b${"x".repeat(50)}|fc_item`, foreign, `a_b${"x".repeat(37)}`);
	check(model, "opaque.without-pipe", foreign, "opaque.without-pipe");
	check(model, "opaque\nitem", foreign, "opaque\nitem");
	for (const field of ["api", "provider", "model"])
		check(model, composite, { ...sameSource(model), [field]: "other" }, callId);
	const limited = target("openai-completions", {
		usesOpenAIToolCallIdLimit: true,
	});
	check(
		limited,
		composite,
		sameSource(limited),
		"call_01a1361b403f7560bacf986beb38cbcc|fc",
	);
	const mistral = target("openai-completions", {
		requiresMistralToolIds: true,
	});
	check(mistral, "a-b|c", foreign, "abcABCDEF");
	check(mistral, composite, sameSource(mistral), "call01a13");
});

test("tool ID table: anthropic-messages", () => {
	const custom = target("anthropic-messages", { officialEndpoint: false });
	check(custom, composite, foreign, sanitized);
	check(custom, composite, sameSource(custom), composite);
	const official = target("anthropic-messages", { officialEndpoint: true });
	check(official, composite, sameSource(official), sanitized);
	check(official, "opaque.id|item", foreign, "opaque_id_item");
});

for (const api of [
	"openai-responses",
	"azure-openai-responses",
	"openai-codex-responses",
]) {
	test(`tool ID table: ${api}`, () => {
		const model = target(api);
		check(model, composite, { ...foreign, api: "openai-completions" }, callId);
		check(model, composite, sameSource(model), callId);
		check(model, "call_plain", foreign, "call_plain");
		check(model, "call_newline\nfc_item", foreign, "call_newline");
		const codex = api === "openai-codex-responses";
		// Literal vectors from the pinned serializer, rather than expectations
		// computed by the production normalizer under test.
		check(
			model,
			"opaque.dot|fc_item",
			sameSource(model),
			codex ? "opaque_dot_199dao2nj54b3" : "opaque.dot",
		);
		check(
			model,
			"opaque.dot|fc_item",
			{ ...foreign, api: "openai-completions" },
			"opaque_dot_199dao2nj54b3",
		);
		check(
			model,
			"x".repeat(90),
			foreign,
			"xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx_1xtgcee1fivbh",
		);
		check(
			model,
			"opaque.dot",
			{ ...sameSource(model), model: "different-model" },
			codex ? "opaque_dot_199dao2nj54b3" : "opaque.dot",
		);
	});
}

test("tool ID table: bedrock-converse-stream", () => {
	const model = target("bedrock-converse-stream");
	check(model, composite, foreign, sanitized);
	check(model, composite, sameSource(model), sanitized);
});

for (const api of [
	"google-generative-ai",
	"google-gemini-cli",
	"google-vertex",
]) {
	test(`tool ID table: ${api}`, () => {
		const model = target(api, { supportsFunctionPartId: true });
		check(model, composite, foreign, sanitized);
		check(model, composite, sameSource(model), composite);
		const prepared = piPreparedStructure(history(composite, foreign), model);
		expect(
			piMatchesPreparedStructure(payload(api, "", "", false), prepared),
		).toBe(false);
		const idless = piPreparedStructure(
			history(composite, foreign),
			target(api, { supportsFunctionPartId: false }),
		);
		expect(
			piMatchesPreparedStructure(payload(api, "", "", false), idless),
		).toBe(true);
		expect(piMatchesPreparedStructure(payload(api, sanitized), idless)).toBe(
			false,
		);
	});
}
