import { describe, expect, test } from "bun:test";
import { createRequire } from "node:module";
import {
	type PiDispatchHost,
	piPreparedStructure,
	piPreparedStructureMismatch,
} from "./pi-dispatch-structure";

/**
 * Host oracle for the prepared tool-call windows (issue 751).
 *
 * Each case runs the real transformMessages of a pinned host package over a
 * randomized history and asserts that the plugin's prepared structure has the
 * rows the host emits, in the host's order. For Oh My Pi it also encodes the
 * host output as a Responses and a Chat Completions request and asserts that
 * the dispatch fence admits it. Pi has no dispatch fence, so its cases compare
 * rows only.
 *
 * Histories come from one model (the target), so the host normalizes no tool
 * ids and the encoders below can emit the host's ids directly. Cross-model id
 * normalization is provider-specific and outside this oracle.
 */

const require = createRequire(import.meta.url);

interface HostTransform {
	version: string;
	host: PiDispatchHost;
	transform: (messages: unknown[], model: unknown) => unknown[];
}

// Loaded by computed path so this package's typecheck does not pull in the
// hosts' own type declarations.
async function load(
	alias: string,
	version: string,
	host: PiDispatchHost,
): Promise<HostTransform> {
	const root = require.resolve(`${alias}/package.json`).slice(0, -12);
	const manifest = require(`${root}package.json`) as { version: string };
	if (manifest.version !== version)
		throw new Error(`${alias} is ${manifest.version}, expected ${version}`);
	const file =
		host === "omp"
			? "src/providers/transform-messages.ts"
			: "dist/api/transform-messages.js";
	const module = (await import(`${root}${file}`)) as {
		transformMessages: HostTransform["transform"];
	};
	return { version, host, transform: module.transformMessages };
}

// The Oh My Pi releases our lanes pin. 18.12.5's transform-messages.ts is
// byte-identical to 18.12.3's.
const hosts = [
	await load("omp-pi-ai-1889", "18.8.9", "omp"),
	await load("omp-pi-ai-1811", "18.11.3", "omp"),
	await load("omp-pi-ai-1812", "18.12.3", "omp"),
	await load("pi-ai-087", "0.87.1", "pi"),
	await load("pi-ai-130", "1.3.0", "pi"),
];

const SEQUENCES = 2000;
const responsesModel = {
	id: "mock",
	api: "openai-responses",
	provider: "zen",
	input: ["text"],
};
const chatModel = { ...responsesModel, api: "openai-completions" };

type Lane = "responses" | "chat" | "mixed" | "pi";
type Message = Record<string, unknown>;

/** Small deterministic PRNG (mulberry32) so a failing case can be replayed. */
function random(seed: number) {
	let state = seed >>> 0;
	const next = () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let value = state;
		value = Math.imul(value ^ (value >>> 15), value | 1);
		value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
		return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
	};
	return {
		int: (bound: number) => Math.floor(next() * bound),
		chance: (probability: number) => next() < probability,
		pick: <T>(values: readonly T[]) =>
			values[Math.floor(next() * values.length)] as T,
	};
}

function callId(r: ReturnType<typeof random>, api: string): string {
	const base = `call_${r.int(5)}`;
	if (api === "openai-responses")
		return r.chance(0.5) ? `${base}|fc_${r.int(3)}` : base;
	return r.chance(0.3) ? `${base}|${r.pick(["first", "second"])}` : base;
}

/**
 * A history mixing tool calls (reused ids, several per turn, aborted turns),
 * results that arrive in their window, late, early or never, duplicate and
 * orphan results, composite ids, and interrupting user, developer and custom
 * messages.
 */
function history(seed: number, lane: Lane): Message[] {
	const r = random(seed);
	let clock = 0;
	const messages: Message[] = [
		{
			role: "user",
			content: [{ type: "text", text: "start" }],
			timestamp: ++clock,
		},
	];
	const called: string[] = [];
	let latest: string[] = [];
	const length = 2 + r.int(14);
	for (let index = 0; index < length; index++) {
		const kind = r.int(100);
		if (kind < 30) {
			const api =
				lane === "mixed"
					? r.pick(["openai-responses", "openai-completions"])
					: lane === "chat"
						? "openai-completions"
						: "openai-responses";
			const ids = Array.from({ length: r.int(4) }, () => callId(r, api));
			const content: unknown[] = [];
			if (!ids.length || r.chance(0.3))
				content.push({ type: "text", text: `answer ${index}` });
			for (const id of ids)
				content.push({ type: "toolCall", id, name: "tool", arguments: {} });
			const stop = r.int(10);
			messages.push({
				role: "assistant",
				content,
				api,
				provider: responsesModel.provider,
				model: responsesModel.id,
				stopReason:
					stop === 0
						? "aborted"
						: stop === 1
							? "error"
							: ids.length
								? "toolUse"
								: "stop",
				timestamp: ++clock,
			});
			called.push(...ids);
			if (ids.length) latest = ids;
		} else if (kind < 65) {
			const choice = r.int(10);
			let id =
				choice < 6 && latest.length
					? r.pick(latest)
					: choice < 8 && called.length
						? r.pick(called)
						: choice < 9
							? `call_${r.int(5)}`
							: "call_9";
			// A Responses result may carry another item half than its call.
			if (lane !== "chat" && id.includes("|fc_") && r.chance(0.3))
				id = `${id.split("|")[0]}|fc_r`;
			messages.push({
				role: "toolResult",
				toolCallId: id,
				toolName: "tool",
				content: [{ type: "text", text: `output ${index}` }],
				isError: r.chance(0.2),
				timestamp: ++clock,
			});
		} else if (kind < 77) {
			messages.push({
				role: "user",
				content: [{ type: "text", text: `user ${index}` }],
				timestamp: ++clock,
			});
		} else if (kind < 87 && lane !== "pi") {
			messages.push({
				role: "developer",
				content: [{ type: "text", text: `developer ${index}` }],
				timestamp: ++clock,
			});
		} else if (kind < 92 && lane === "pi") {
			messages.push({
				role: "system",
				content: [{ type: "text", text: `system ${index}` }],
				timestamp: ++clock,
			});
		} else {
			messages.push({
				role: "custom",
				customType: "async-result",
				content: `notice ${index}`,
				display: false,
				attribution: "agent",
				timestamp: ++clock,
			});
		}
	}
	return messages;
}

/** What Pi's convertToLlm hands its transform: custom messages become user. */
function piLlmMessages(messages: Message[]): Message[] {
	return messages.map((message) =>
		message.role === "custom"
			? {
					role: "user",
					content: [{ type: "text", text: message.content }],
					timestamp: message.timestamp,
				}
			: message,
	);
}

function textOf(message: Message): string {
	if (typeof message.content === "string") return message.content;
	return (message.content as { type: string; text?: string }[])
		.filter((part) => part.type === "text")
		.map((part) => part.text)
		.join("\n");
}

function callsOf(message: Message): string[] {
	return (message.content as { type: string; id?: string }[])
		.filter((part) => part.type === "toolCall")
		.map((part) => part.id as string);
}

const isNote = (message: Message) =>
	message.role === "user" &&
	typeof message.content === "string" &&
	message.content.startsWith("<stale-tool-result");

/** The host's emitted rows: role, ordered call and result ids, and note text. */
function hostRows(messages: unknown[]): string[] {
	return (messages as Message[]).map((message) => {
		const role =
			message.role === "assistant" ||
			message.role === "toolResult" ||
			message.role === "system"
				? message.role
				: "user";
		const calls = role === "assistant" ? callsOf(message) : [];
		const results = role === "toolResult" ? [message.toolCallId as string] : [];
		const note = isNote(message) ? ` ${textOf(message)}` : "";
		return `${role} [${calls}] [${results}]${note}`;
	});
}

function preparedRows(
	structure: ReturnType<typeof piPreparedStructure>,
): string[] | undefined {
	return structure?.messages.map(
		(row) =>
			`${row.role} [${row.calls}] [${row.results}]${row.exactText === undefined ? "" : ` ${row.exactText}`}`,
	);
}

const wireCallId = (id: string) => id.split("|")[0];

function responsesPayload(messages: unknown[]) {
	return {
		model: responsesModel.id,
		input: (messages as Message[]).flatMap((message) => {
			if (message.role === "toolResult")
				return [
					{
						type: "function_call_output",
						call_id: wireCallId(message.toolCallId as string),
						output: textOf(message),
					},
				];
			if (message.role !== "assistant")
				return [
					{
						type: "message",
						role: message.role === "developer" ? "developer" : "user",
						content: [{ type: "input_text", text: textOf(message) }],
					},
				];
			return (message.content as Message[]).map((part) =>
				part.type === "text"
					? {
							type: "message",
							role: "assistant",
							content: [
								{ type: "output_text", text: part.text, annotations: [] },
							],
						}
					: {
							type: "function_call",
							call_id: wireCallId(part.id as string),
							name: part.name,
							arguments: "{}",
						},
			);
		}),
	};
}

function chatPayload(messages: unknown[]) {
	return {
		model: chatModel.id,
		messages: (messages as Message[]).map((message) => {
			if (message.role === "toolResult")
				return {
					role: "tool",
					tool_call_id: message.toolCallId,
					content: textOf(message),
				};
			if (message.role !== "assistant")
				return {
					role: message.role === "developer" ? "developer" : "user",
					content: textOf(message),
				};
			const text = (message.content as Message[]).find(
				(part) => part.type === "text",
			);
			const calls = callsOf(message);
			return {
				role: "assistant",
				content: text ? text.text : null,
				...(calls.length
					? {
							tool_calls: calls.map((id) => ({
								type: "function",
								id,
								function: { name: "tool", arguments: "{}" },
							})),
						}
					: {}),
			};
		}),
	};
}

interface Divergence {
	seed: number;
	reason: string;
	history: Message[];
	host?: string[];
	prepared?: string[];
}

/** Run one lane; return the first few divergences and how many cases moved a result. */
function runLane(host: HostTransform, lane: Lane) {
	const divergences: Divergence[] = [];
	let moved = 0;
	// How often each host rule fired, so a generator that stops reaching one
	// cannot pass vacuously.
	const reached = { dup: 0, stub: 0, aborted: 0, note: 0, dropped: 0 };
	const model =
		lane === "responses"
			? responsesModel
			: lane === "pi"
				? undefined
				: chatModel;
	for (let seed = 1; seed <= SEQUENCES; seed++) {
		const messages = history(seed * 7919 + lane.length, lane);
		const hostInput = host.host === "pi" ? piLlmMessages(messages) : messages;
		const input = structuredClone(hostInput);
		const emitted = host.transform(input, model ?? chatModel);
		const expected = hostRows(emitted);
		// Count cases where the host emitted some input message out of its input
		// order, which on Oh My Pi is a moved result.
		const order = emitted
			.map((message) => input.indexOf(message as Message))
			.filter((index) => index >= 0);
		if (order.some((index, at) => at > 0 && index < order[at - 1])) moved++;
		const results = (emitted as Message[]).filter(
			(message) => message.role === "toolResult",
		);
		if (
			(emitted as Message[]).some(
				(message) =>
					message.role === "assistant" &&
					callsOf(message).some((id) => id.includes("_dup")),
			)
		)
			reached.dup++;
		if (results.some((message) => textOf(message) === "No result provided"))
			reached.stub++;
		if (results.some((message) => textOf(message) === "aborted"))
			reached.aborted++;
		if ((emitted as Message[]).some(isNote)) reached.note++;
		// Fewer real results than the history had: a duplicate, early or
		// orphan result was dropped.
		if (
			results.filter((message) => textOf(message).startsWith("output")).length <
			input.filter((message) => message.role === "toolResult").length
		)
			reached.dropped++;
		const prepared = piPreparedStructure(
			structuredClone(messages),
			model,
			host.host,
		);
		const rows = preparedRows(prepared);
		if (JSON.stringify(rows) !== JSON.stringify(expected)) {
			divergences.push({
				seed,
				reason: "rows",
				history: messages,
				host: expected,
				prepared: rows,
			});
		} else if (lane === "responses" || lane === "chat") {
			const payload =
				lane === "responses" ? responsesPayload(emitted) : chatPayload(emitted);
			const mismatch = piPreparedStructureMismatch(payload, prepared);
			if (mismatch)
				divergences.push({ seed, reason: mismatch, history: messages });
		}
		if (divergences.length >= 3) break;
	}
	return { divergences, moved, reached };
}

describe("issue 751 host oracle: prepared tool windows match the real host transform", () => {
	for (const host of hosts) {
		const lanes: Lane[] =
			host.host === "omp" ? ["responses", "chat", "mixed"] : ["pi"];
		for (const lane of lanes) {
			const label =
				lane === "responses"
					? "Responses lane fence"
					: lane === "chat"
						? "chat-completions lane fence"
						: lane === "mixed"
							? "mixed-origin pairing rows"
							: "rows";
			test(`${host.host} ${host.version}: ${label} over ${SEQUENCES} randomized histories`, () => {
				const { divergences, moved, reached } = runLane(host, lane);
				expect(divergences).toEqual([]);
				// The generator must actually reach the rules it guards.
				expect(reached.stub).toBeGreaterThan(100);
				if (host.host === "omp") {
					expect(moved).toBeGreaterThan(100);
					expect(reached.dup).toBeGreaterThan(50);
					expect(reached.aborted).toBeGreaterThan(50);
					expect(reached.note).toBeGreaterThan(50);
					expect(reached.dropped).toBeGreaterThan(100);
				}
			});
		}
	}
});
