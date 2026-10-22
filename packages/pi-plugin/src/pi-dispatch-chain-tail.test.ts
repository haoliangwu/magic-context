import { expect, test } from "bun:test";
import { piEncodeChainTail } from "./pi-dispatch-chain-tail";

const model = {
	api: "openai-codex-responses",
	id: "gpt-6.1-sol",
	provider: "openai-codex",
	input: ["text", "image"],
};
const assistant = {
	role: "assistant",
	api: model.api,
	model: model.id,
	provider: model.provider,
};
const call = { type: "function_call", call_id: "call_1" };
const result = {
	role: "toolResult",
	toolCallId: "call_1|fc_1",
	content: [
		{ type: "text", text: "first" },
		{ type: "text", text: "second" },
	],
};
const image = {
	type: "image",
	mimeType: "image/png",
	data: "aW1hZ2U=",
	detail: "original",
};

test("chain tail encoding: text results join blocks and custom calls retain their output type", () => {
	expect(piEncodeChainTail([result], assistant, [call], model)).toEqual([
		{
			type: "function_call_output",
			call_id: "call_1",
			output: "first\nsecond",
		},
	]);
	expect(
		piEncodeChainTail(
			[result],
			assistant,
			[{ ...call, type: "custom_tool_call" }],
			model,
		),
	).toEqual([
		{
			type: "custom_tool_call_output",
			call_id: "call_1",
			output: "first\nsecond",
		},
	]);
});

test("chain tail encoding: user images follow text but tool-result images retain block order", () => {
	const content = [image, { type: "text", text: "caption" }];
	const encodedImage = {
		type: "input_image",
		detail: "auto",
		image_url: "data:image/png;base64,aW1hZ2U=",
	};
	expect(
		piEncodeChainTail([{ role: "user", content }], assistant, [call], model),
	).toEqual([
		{
			role: "user",
			content: [{ type: "input_text", text: "caption" }, encodedImage],
		},
	]);
	expect(
		piEncodeChainTail([{ ...result, content }], assistant, [call], model),
	).toEqual([
		{
			type: "function_call_output",
			call_id: "call_1",
			output: [encodedImage, { type: "input_text", text: "caption" }],
		},
	]);
});

test("chain tail encoding: non-vision results use the exact omitted-image separator", () => {
	expect(
		piEncodeChainTail(
			[{ ...result, content: [...result.content, image] }],
			assistant,
			[call],
			{ ...model, input: ["text"] },
		),
	).toEqual([
		{
			type: "function_call_output",
			call_id: "call_1",
			output: "first\nsecond\n[image omitted: model does not support vision]",
		},
	]);
});

test("chain tail encoding: Harmony escaping and malformed Unicode follow the provider", () => {
	const content = "<|start|>\uD800";
	expect(
		piEncodeChainTail([{ role: "developer", content }], assistant, [call], {
			...model,
			identity: { class: "gpt-oss" },
		}),
	).toEqual([
		{
			role: "developer",
			content: [{ type: "input_text", text: "<\\|start\\|>\uFFFD" }],
		},
	]);
});

test("chain tail encoding: unknown roles, native carriers and unpaired results are not guessed", () => {
	expect(
		piEncodeChainTail(
			[{ role: "custom", content: "unknown" }],
			assistant,
			[call],
			model,
		),
	).toBeUndefined();
	expect(
		piEncodeChainTail(
			[{ role: "user", content: "text", providerPayload: {} }],
			assistant,
			[call],
			model,
		),
	).toBeUndefined();
	expect(piEncodeChainTail([result], assistant, [], model)).toBeUndefined();
});

test("chain tail encoding: hidden custom notices retain each Responses provider's role", () => {
	const notice = {
		role: "custom",
		customType: "eval-state-context",
		display: false,
		attribution: "agent",
		content:
			"<system-reminder>Eval runtime state is host-retained.</system-reminder>",
	};
	for (const api of [
		"openai-codex-responses",
		"openai-responses",
		"azure-openai-responses",
	]) {
		expect(
			piEncodeChainTail([notice], assistant, [], { ...model, api }),
		).toEqual([
			{
				role: api === "openai-codex-responses" ? "developer" : "user",
				content: [{ type: "input_text", text: notice.content }],
			},
		]);
	}
	expect(
		piEncodeChainTail(
			[{ role: "system", content: notice.content }],
			assistant,
			[],
			model,
		),
	).toBeUndefined();
});
