import { afterEach, expect, test } from "bun:test";
import {
	clearPiContextReceipt,
	registerPiGuardedContext,
} from "./pi-context-refusal";
import {
	piPreparedStructure,
	preparePiDispatch,
} from "./pi-dispatch-structure";
import { __setPiHarnessKindForTesting } from "./pi-harness-kind";
import { fakeContext, userMessage } from "./test-utils.test";

const model = { api: "openai-responses", provider: "mock", id: "mock" };
const payload = {
	type: "openaiResponsesHistory",
	provider: "mock",
	items: [{ type: "compaction", encrypted_content: "opaque compaction" }],
};
const carrier = () => ({
	...userMessage("Readable compaction summary", 1),
	providerPayload: structuredClone(payload),
});

afterEach(() => {
	clearPiContextReceipt("issue-692");
	__setPiHarnessKindForTesting(undefined);
});

test("issue 692 user compaction carrier returns a copy without opaque replay", () => {
	const message = carrier();
	const before = JSON.stringify(message);
	Object.freeze(message);
	const input = [message];
	const result = preparePiDispatch(input, model, true);
	expect(result.messages).not.toBe(input);
	expect(result.messages[0]).not.toBe(message);
	expect(Object.hasOwn(result.messages[0], "providerPayload")).toBe(false);
	expect(result.messages[0].content).toBe(message.content);
	expect(JSON.stringify(message)).toBe(before);
	expect(result.structure).toEqual(piPreparedStructure(input, model));
});

test("issue 692 re-preparation and restart have deterministic bytes", () => {
	const persisted = JSON.stringify([carrier(), userMessage("next", 2)]);
	const first = preparePiDispatch(JSON.parse(persisted), model, true).messages;
	const second = preparePiDispatch(first, model, true).messages;
	const restarted = preparePiDispatch(
		JSON.parse(persisted),
		model,
		true,
	).messages;
	expect(second).toBe(first);
	expect(JSON.stringify(second)).toBe(JSON.stringify(restarted));
	expect(JSON.stringify(first)).not.toBe(persisted);
});

test("issue 692 carrier after a synthesized tool result is stripped at its own index", () => {
	// The structure walk inserts Oh My Pi's synthesized result for the dangling
	// call, so projected positions run one ahead of the returned array from here.
	const danglingCall = {
		role: "assistant",
		content: [{ type: "toolCall", id: "call-1", name: "bash", arguments: {} }],
		stopReason: "toolUse",
		timestamp: 1,
	};
	const next = userMessage("after the interrupted call", 2);
	const input = [userMessage("start", 0), danglingCall, next, carrier()];
	const output = preparePiDispatch(input, model, true).messages;
	expect(output).toHaveLength(input.length);
	expect(output[2]).toBe(next);
	expect(Object.hasOwn(output[3], "providerPayload")).toBe(false);
	expect(output[3].content).toBe(input[3].content);
});

test("issue 692 native compactionSummary keeps its renderer fields", () => {
	const summary = {
		role: "compactionSummary",
		summary: "Readable native summary",
		shortSummary: "Short summary",
		tokensBefore: 50000,
		timestamp: 1700000000000,
		providerPayload: payload,
	};
	const { providerPayload: _payload, ...expected } = summary;
	const output = preparePiDispatch([summary], model, true).messages;
	expect(output[0]).toEqual(expected);
	expect(summary.providerPayload).toBe(payload);
});

test("issue 692 assistant native-only reasoning and other carriers stay untouched", () => {
	const reasoningPayload = {
		...payload,
		items: [{ type: "reasoning", id: "rs_692", encrypted_content: "opaque" }],
	};
	const assistant = {
		role: "assistant",
		content: [{ type: "thinking", thinking: "summary" }],
		providerPayload: reasoningPayload,
	};
	const foreign = {
		...carrier(),
		providerPayload: { type: "other", items: [] },
	};
	const absent = userMessage("ordinary", 2);
	const input = [assistant, foreign, absent];
	const before = JSON.stringify(input);
	const result = preparePiDispatch(input, model, true);
	expect(result.messages).toBe(input);
	expect(result.messages[0]).toBe(assistant);
	expect(assistant.providerPayload).toBe(reasoningPayload);
	expect(JSON.stringify(result.messages)).toBe(before);
	expect(
		preparePiDispatch([carrier()], model, false).messages[0],
	).toHaveProperty("providerPayload");
});

test("issue 692 ordinary preparation adds no message walk or assistant payload reads", () => {
	const counts = { messages: 0, userPayloads: 0, assistantPayloads: 0 };
	const input = new Proxy(
		Array.from({ length: 100 }, (_, i) =>
			i % 2
				? {
						role: "assistant",
						content: [{ type: "text", text: "answer" }],
						get providerPayload() {
							counts.assistantPayloads++;
							return undefined;
						},
					}
				: {
						...userMessage("ordinary", i),
						get providerPayload() {
							counts.userPayloads++;
							return undefined;
						},
					},
		),
		{
			get(target, key, receiver) {
				if (typeof key === "string" && /^\d+$/.test(key)) counts.messages++;
				return Reflect.get(target, key, receiver);
			},
		},
	);
	const chat = { ...model, api: "openai-completions" };
	const baseline = piPreparedStructure(input, chat);
	const baselineVisits = counts.messages;
	counts.messages = 0;
	counts.userPayloads = 0;
	counts.assistantPayloads = 0;
	const result = preparePiDispatch(input, chat, true);
	expect(result.messages).toBe(input);
	expect(result.structure).toEqual(baseline);
	expect(counts.messages).toBe(baselineVisits);
	expect(counts.userPayloads).toBe(50);
	expect(counts.assistantPayloads).toBe(0);
});

for (const api of [
	"openai-responses",
	"openai-codex-responses",
	"azure-openai-responses",
	"openai-completions",
]) {
	test(`issue 692 guarded ${api} output normalizes fresh and recovered arrays`, async () => {
		__setPiHarnessKindForTesting("omp");
		const handlers = new Map<
			string,
			(event: unknown, ctx: unknown) => unknown
		>();
		let aborts = 0;
		const ctx = {
			...fakeContext("issue-692"),
			model: { ...model, api },
			abort: () => aborts++,
		};
		const stored = [carrier()];
		let output = stored;
		registerPiGuardedContext(
			{
				on: (name: string, fn: (event: unknown, ctx: unknown) => unknown) =>
					handlers.set(name, fn),
				appendEntry: () => {},
			} as never,
			async () => ({ messages: output }) as never,
		);
		const emit = (name: string, event: unknown = {}) =>
			handlers.get(name)?.(event, ctx);
		for (let pass = 0; pass < 3; pass++) {
			emit("agent_start");
			// A recovery result can reuse an earlier returned array or reconstruct
			// the persisted carrier. Both must go through final dispatch preparation.
			if (pass === 2) output = JSON.parse(JSON.stringify(stored));
			const result = (await emit("context", { messages: stored })) as {
				messages: typeof stored;
			};
			expect(result.messages[0]).not.toHaveProperty("providerPayload");
			expect(stored[0].providerPayload).toEqual(payload);
			output = result.messages;
			emit("before_provider_request", {
				payload:
					api === "openai-completions"
						? {
								messages: [
									{ role: "user", content: "Readable compaction summary" },
								],
							}
						: {
								input: [
									{ role: "user", content: "Readable compaction summary" },
								],
							},
			});
			emit("agent_end", { messages: stored });
		}
		expect(aborts).toBe(0);
	});
}
