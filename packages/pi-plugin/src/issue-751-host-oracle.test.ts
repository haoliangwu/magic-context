import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	cleanupTestTempDir,
	createTestTempDirFromPath,
} from "@magic-context/core/shared/test-temp-dir";
import {
	exerciseOmpLoggerFiles,
	pinOmpLoggerFiles,
	reportOmpLogDescriptors,
} from "./__tests__/omp-log-files";
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

const parent = join(tmpdir(), "magic-context", "issue-766");
mkdirSync(parent, { recursive: true });
const hostRoot = createTestTempDirFromPath(join(parent, "host-oracle-"));
afterAll(() => cleanupTestTempDir(hostRoot));
const ompVersions = [
	["omp-pi-ai-1889", "18.8.9"],
	["omp-pi-ai-1811", "18.11.3"],
	["omp-pi-ai-1812", "18.12.3"],
] as const;
const ompLoggerAliases = ompVersions.map(([alias]) => alias);

async function loadOmpHosts(): Promise<HostTransform[]> {
	const environment = {
		HOME: join(hostRoot, "home"),
		XDG_CONFIG_HOME: join(hostRoot, "config"),
		XDG_DATA_HOME: join(hostRoot, "data"),
		XDG_CACHE_HOME: join(hostRoot, "cache"),
		XDG_STATE_HOME: join(hostRoot, "state"),
	};
	const previous = Object.fromEntries(
		Object.keys(environment).map((key) => [key, process.env[key]]),
	);
	// OMP captures log/config paths during import; later tests keep their own environment.
	for (const [key, value] of Object.entries(environment)) {
		mkdirSync(value, { recursive: true });
		process.env[key] = value;
	}
	try {
		await pinOmpLoggerFiles(hostRoot, ompLoggerAliases);
		// Cover the supported OMP converters. The 18.12.5 transform is byte-identical
		// to 18.12.3, so loading 18.12.3 also covers that release.
		const hosts: HostTransform[] = [];
		for (const [alias, version] of ompVersions) {
			hosts.push(await load(alias, version, "omp"));
		}
		return hosts;
	} finally {
		for (const [key, value] of Object.entries(previous)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
}

const hosts = [
	...(await loadOmpHosts()),
	await load("pi-ai-087", "0.87.1", "pi"),
	await load("pi-ai-130", "1.3.0", "pi"),
];

// Exercise real sinks after HOME is restored so lsof observes files,
// not just configured paths.
await exerciseOmpLoggerFiles(ompLoggerAliases);
reportOmpLogDescriptors();

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

// Only APIs whose provider sources establish a transformMessages call belong
// here. The unverified-API tests below pin the other APIs' serialized structure.
const transformedApis = [
	"openai-completions",
	"openai-responses",
	"openrouter",
	"openai-codex-responses",
	"azure-openai-responses",
	"anthropic-messages",
	"bedrock-converse-stream",
	"google-generative-ai",
	"google-gemini-cli",
	"google-vertex",
	"ollama-chat",
	"factory-droid-agent",
	"devin-agent",
	"apple-foundation-models",
];

/** User, interrupted thinking-only assistant, user (Zireael, issue 761 comment 3). */
function thinkingHistory(stopReason: string): Message[] {
	return [
		{ role: "user", content: [{ type: "text", text: "go" }], timestamp: 1 },
		{
			role: "assistant",
			content: [{ type: "thinking", thinking: "weighing options" }],
			stopReason,
			timestamp: 2,
		},
		{
			role: "user",
			content: [{ type: "text", text: "continue" }],
			timestamp: 3,
		},
	];
}

/** Encode the no-tool oracle output in the target provider's conversation shape. */
function thinkingPayload(messages: unknown[], api: string) {
	if (api.includes("responses")) return responsesPayload(messages);
	if (api.startsWith("google-"))
		return {
			contents: (messages as Message[]).map((message) => ({
				role: message.role === "assistant" ? "model" : "user",
				parts: [{ text: textOf(message) }],
			})),
		};
	return {
		...chatPayload(messages),
		...(api === "anthropic-messages" ? { system: [], max_tokens: 100 } : {}),
		...(api === "bedrock-converse-stream" ? { inferenceConfig: {} } : {}),
	};
}

describe("truncated thinking-only host oracle", () => {
	for (const host of hosts.filter((entry) => entry.host === "omp")) {
		for (const api of transformedApis) {
			const model = { ...chatModel, api, compat: {} };
			test(`omp ${host.version}: ${api}: Zireael minimal fixture`, () => {
				for (const stopReason of ["length", "error", "aborted"]) {
					const messages = thinkingHistory(stopReason);
					const bytes = JSON.stringify(messages);
					const emitted = host.transform(structuredClone(messages), model);
					expect(hostRows(emitted)).toEqual(["user [] []", "user [] []"]);
					const prepared = piPreparedStructure(messages, model);
					expect(preparedRows(prepared)).toEqual(hostRows(emitted));
					expect(
						piPreparedStructureMismatch(
							thinkingPayload(emitted, api),
							prepared,
						),
					).toBeUndefined();
					expect(JSON.stringify(messages)).toBe(bytes);
				}
			});
			test(`omp ${host.version}: ${api}: Qiiks 104 to 103 row fixture`, () => {
				const messages: Message[] = Array.from({ length: 104 }, (_, index) => ({
					role: index % 2 === 0 ? "user" : "assistant",
					content: [{ type: "text", text: `turn ${index}` }],
					stopReason: "stop",
					timestamp: index + 1,
				}));
				messages[7] = thinkingHistory("length")[1];
				const emitted = host.transform(structuredClone(messages), model);
				expect(emitted).toHaveLength(103);
				const prepared = piPreparedStructure(messages, model);
				expect(
					piPreparedStructureMismatch(thinkingPayload(emitted, api), prepared),
				).toBeUndefined();
				expect(preparedRows(prepared)).toEqual(hostRows(emitted));
			});
			test(`omp ${host.version}: ${api}: text and tool calls survive truncation`, () => {
				for (const stopReason of ["length", "error", "aborted"]) {
					for (const block of [
						{ type: "text", text: "answer" },
						{ type: "text", text: "" },
						{ type: "toolCall", id: "call_A", name: "tool", arguments: {} },
					]) {
						const messages = thinkingHistory(stopReason);
						(messages[1].content as unknown[]).push(block);
						const emitted = host.transform(structuredClone(messages), model);
						expect(
							(emitted as Message[]).some((row) => row.role === "assistant"),
						).toBe(true);
						const prepared = piPreparedStructure(messages, model);
						expect(preparedRows(prepared)).toEqual(hostRows(emitted));
						expect(prepared?.messages[1].role).toBe("assistant");
					}
				}
				const messages = thinkingHistory("stop");
				expect(host.transform(structuredClone(messages), model)).toHaveLength(
					3,
				);
				expect(piPreparedStructure(messages, model)?.messages).toHaveLength(3);
			});
		}
	}
	for (const host of hosts.filter((entry) => entry.host === "pi")) {
		test(`pi ${host.version}: interrupted thinking keeps Pi's own transform rules`, () => {
			for (const stopReason of ["length", "error", "aborted", "stop"]) {
				const messages = thinkingHistory(stopReason);
				const emitted = host.transform(structuredClone(messages), chatModel);
				expect(emitted).toHaveLength(
					stopReason === "error" || stopReason === "aborted" ? 2 : 3,
				);
				expect(
					preparedRows(piPreparedStructure(messages, chatModel, "pi")),
				).toEqual(hostRows(emitted));
			}
		});
	}
});

for (const api of [
	undefined,
	"cursor-agent",
	"gitlab-duo-agent",
	"vertex-claude-api",
	"opencode-free-zen",
]) {
	test(`unverified API ${api ?? "(no model)"}: thinking-only structure is byte-identical to base`, () => {
		for (const stopReason of ["length", "error", "aborted", "stop"]) {
			const model = api ? { ...chatModel, api } : undefined;
			// Captured on c1becce52: without a verified host transform, retain the
			// assistant row even when it contains only interrupted thinking.
			const expected =
				'{"messages":[{"role":"user","calls":[],"results":[],"timestamp":1},{"role":"assistant","calls":[],"results":[],"timestamp":2},{"role":"user","calls":[],"results":[],"timestamp":3}]' +
				(api ? `,"api":"${api}"}` : "}");
			expect(
				JSON.stringify(piPreparedStructure(thinkingHistory(stopReason), model)),
			).toBe(expected);
		}
	});
}
