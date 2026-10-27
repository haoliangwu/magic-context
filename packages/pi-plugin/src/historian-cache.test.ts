import { expect, test } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import extension, {
	HISTORIAN_CACHE_TAIL_ENV,
} from "./historian-calibration-extension";

const payload = {
	model: "claude-test",
	max_tokens: 1000,
	system: [
		{ type: "text", text: "stable", cache_control: { type: "ephemeral" } },
	],
	messages: [
		{
			role: "user",
			content: [
				{
					type: "text",
					text: "variable",
					cache_control: { type: "ephemeral" },
				},
			],
		},
	],
};
function listeners(cacheTail?: string) {
	const saved = { ...process.env };
	const handlers: Array<(event: { payload: unknown }) => unknown> = [];
	try {
		for (const key of [
			HISTORIAN_CACHE_TAIL_ENV,
			"MAGIC_CONTEXT_SUBAGENT_PROMPT_FILE",
			"MAGIC_CONTEXT_HISTORIAN_TEMPERATURE",
			"MAGIC_CONTEXT_HISTORIAN_MAX_OUTPUT_TOKENS",
			"MAGIC_CONTEXT_SUBAGENT_OUTPUT_CEILING",
		])
			delete process.env[key];
		if (cacheTail) process.env[HISTORIAN_CACHE_TAIL_ENV] = cacheTail;
		extension({
			registerFlag: () => {},
			on: (
				event: string,
				callback: (event: { payload: unknown }) => unknown,
			) => {
				if (event === "before_provider_request") handlers.push(callback);
			},
		} as unknown as ExtensionAPI);
	} finally {
		process.env = saved;
	}
	return (input: unknown) =>
		handlers.reduce(
			(value, handler) => handler({ payload: value }) ?? value,
			input,
		);
}

test("Pi child skip removes only marker bytes and later provider turns retain the tail", () => {
	const apply = listeners("skip");
	const before = JSON.stringify(payload);
	const expected = before.replace(
		',"cache_control":{"type":"ephemeral"}}]}]',
		"}]}]",
	);
	expect(JSON.stringify(apply(payload))).toBe(expected);
	expect(JSON.stringify(apply(payload))).toBe(before);
});

test("Pi outer retry write preserves body bytes and the reusable tail", () => {
	expect(JSON.stringify(listeners("write")(payload))).toBe(
		JSON.stringify(payload),
	);
});

test("Pi main-session request is byte-identical without child admission", () => {
	expect(JSON.stringify(listeners()(payload))).toBe(JSON.stringify(payload));
});

test("Pi malformed or unknown payload passes through unchanged", () => {
	const unknown = { generationConfig: { maxOutputTokens: 100 }, contents: [] };
	expect(listeners("skip")(unknown)).toBe(unknown);
	const cycle: Record<string, unknown> = {};
	cycle.self = cycle;
	expect(listeners("skip")(cycle)).toBe(cycle);
});
