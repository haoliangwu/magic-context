/**
 * Issue 586: on Pi the placeholder strip removes a frozen message by id on every
 * pass, while the tool-drop replay decides per pass whether a dropped call is
 * removed or kept as a pair. Whenever the tool replay keeps a call inside a
 * message the strip removes, the call's result is left without its call, which
 * Responses endpoints reject with `400 invalid function_call_output`.
 *
 * These passes drive the real context handler over a tool-heavy transcript with
 * encrypted reasoning (the openai-responses shape) and check every output for
 * results without their call, and defer passes for byte identity.
 */
import { describe, expect, it } from "bun:test";
import { convertResponsesMessages } from "@earendil-works/pi-ai/api/openai-responses-shared";
import {
	getStrippedPlaceholderIds,
	getTagsBySession,
	updateSessionMeta,
	updateTagDropMode,
	updateTagStatus,
} from "@magic-context/core/features/magic-context/storage";
import {
	clearContextHandlerSession,
	recordPiLiveModel,
	registerPiContextHandler,
	signalPiHistoryRefresh,
} from "./context-handler";
import {
	assistantMessage,
	createFakePi,
	createTestDb,
	fakeContext,
	toolResultMessage,
	userMessage,
} from "./test-utils.test";

type Message = Record<string, unknown>;

/**
 * Mirrors what Pi's Responses serializer sends: one function_call per toolCall
 * of a replayable assistant, and one function_call_output for every toolResult
 * whether or not its call is still there. Returns results without an earlier call.
 */
export function orphanToolResults(messages: readonly unknown[]): string[] {
	const calls = new Set<string>();
	const orphans: string[] = [];
	for (const raw of messages as Message[]) {
		if (
			raw.role === "assistant" &&
			raw.stopReason !== "error" &&
			raw.stopReason !== "aborted"
		) {
			for (const part of (Array.isArray(raw.content)
				? raw.content
				: []) as Message[])
				if (part.type === "toolCall") calls.add(String(part.id));
		}
		if (raw.role === "toolResult" && !calls.has(String(raw.toolCallId)))
			orphans.push(String(raw.toolCallId));
	}
	return orphans;
}

/** The same check over Pi's own Responses serializer: the `input` a relay receives. */
function responsesWireOrphans(messages: readonly unknown[]): string[] {
	const input = convertResponsesMessages(
		{
			...RELAY,
			name: RELAY.id,
			baseUrl: "https://invalid.invalid",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 100_000,
			maxTokens: 1024,
		} as never,
		{ messages } as never,
		new Set(["openai"]),
	) as unknown as Message[];
	const calls = new Set<string>();
	const orphans: string[] = [];
	for (const item of input) {
		if (item.type === "function_call") calls.add(String(item.call_id));
		if (
			item.type === "function_call_output" &&
			!calls.has(String(item.call_id))
		)
			orphans.push(String(item.call_id));
	}
	return orphans;
}

const RELAY = { id: "gpt-relay", api: "openai-responses", provider: "relay" };
const GATEWAY = {
	id: "local-chat",
	api: "openai-completions",
	provider: "gateway",
};

function fixture(session: string) {
	const db = createTestDb();
	const fake = createFakePi();
	const count = 24;
	const source = [
		userMessage("first", 1),
		...Array.from({ length: count }, (_, i) => [
			assistantMessage("", 2 + i * 2, {
				api: RELAY.api,
				provider: RELAY.provider,
				model: RELAY.id,
				stopReason: "toolUse",
				content: [
					{
						type: "thinking",
						thinking: "",
						thinkingSignature: JSON.stringify({
							type: "reasoning",
							id: `rs-${i}`,
							summary: [],
							encrypted_content: "x".repeat(40),
						}),
					},
					{
						type: "toolCall",
						id: `call-${i}|fc-${i}`,
						name: "read",
						arguments: { path: `file-${i}` },
					},
				],
			}),
			toolResultMessage(
				`call-${i}|fc-${i}`,
				`output-${i} ${"y".repeat(400)}`,
				3 + i * 2,
			),
		]).flat(),
		userMessage("continue", 1000),
	];
	const ids = source.map((_, i) => `entry-${i}`);
	registerPiContextHandler(
		fake.pi as never,
		{
			db,
			heuristics: { clearReasoningAge: 5 },
			injection: { injectionBudgetTokens: 10_000 },
			scheduler: { executeThresholdPercentage: 80 },
		} as never,
	);
	updateSessionMeta(db, session, {
		piStableIdScheme: 1,
		systemPromptHash: "sys-v1",
	});
	let model = RELAY;
	const handler = fake.handlers.get("context") as unknown as (
		input: { messages: unknown[] },
		ctx: unknown,
	) => Promise<{ messages: unknown[] }>;
	const pass = async (percent: number, opts: { refresh?: boolean } = {}) => {
		if (opts.refresh) signalPiHistoryRefresh(session);
		updateSessionMeta(db, session, {
			lastResponseTime: Date.now(),
			cacheTtl: "59m",
		});
		const messages = structuredClone(source);
		const out = await handler(
			{ messages },
			{
				...fakeContext(session, process.cwd(), ids, messages),
				model: { ...model, contextWindow: 100_000 },
				getContextUsage: () => ({
					percent,
					tokens: percent * 1000,
					contextWindow: 100_000,
				}),
			},
		);
		return out.messages;
	};
	const useModel = (next: typeof RELAY) => {
		model = next;
		recordPiLiveModel(session, `${next.provider}/${next.id}`);
	};
	recordPiLiveModel(session, `${RELAY.provider}/${RELAY.id}`);
	/** Tag, drop every tool arc but the newest few as `full`, remove them, then discover placeholders. */
	const dropAndDiscover = async () => {
		await pass(0);
		for (const tag of getTagsBySession(db, session))
			if (tag.type === "tool" && tag.tagNumber < count - 2) {
				updateTagStatus(db, session, tag.tagNumber, "dropped");
				updateTagDropMode(db, session, tag.tagNumber, "full");
			}
		await pass(90);
		return pass(0, { refresh: true });
	};
	const toolModes = () =>
		getTagsBySession(db, session)
			.filter((tag) => tag.type === "tool" && tag.status === "dropped")
			.map((tag) => tag.dropMode);
	return {
		db,
		session,
		pass,
		useModel,
		dropAndDiscover,
		toolModes,
		close: () => {
			clearContextHandlerSession(session);
			db.close();
		},
	};
}

describe("issue 586: placeholder strip keeps tool calls and results together", () => {
	it("a model round trip through a pair-keeping API never strands a result", async () => {
		const f = fixture("issue-586-round-trip");
		try {
			const discovered = await f.dropAndDiscover();
			expect(getStrippedPlaceholderIds(f.db, f.session).size).toBeGreaterThan(
				0,
			);
			expect(orphanToolResults(discovered)).toEqual([]);
			const relayDeferPass = await f.pass(0);
			expect(responsesWireOrphans(relayDeferPass)).toEqual([]);
			const relayDefer = JSON.stringify(relayDeferPass);
			expect(JSON.stringify(await f.pass(0))).toBe(relayDefer);

			// The local gateway must keep tool pairs beside reasoning, so the
			// tool-drop replay keeps each dropped call as a pair on these passes.
			f.useModel(GATEWAY);
			const gatewayFirst = await f.pass(0);
			expect(orphanToolResults(gatewayFirst)).toEqual([]);
			const gatewayDefer = await f.pass(0);
			expect(orphanToolResults(gatewayDefer)).toEqual([]);
			expect(JSON.stringify(await f.pass(0))).toBe(
				JSON.stringify(gatewayDefer),
			);
			// The HARD fold on the switch must not demote removed arcs for good.
			expect(new Set(f.toolModes())).toEqual(new Set(["full"]));

			f.useModel(RELAY);
			const relayFirst = await f.pass(0);
			expect(orphanToolResults(relayFirst)).toEqual([]);
			expect(responsesWireOrphans(relayFirst)).toEqual([]);
			const relayAgain = await f.pass(0);
			expect(orphanToolResults(relayAgain)).toEqual([]);
			expect(responsesWireOrphans(relayAgain)).toEqual([]);
			expect(JSON.stringify(await f.pass(0))).toBe(JSON.stringify(relayAgain));
			// Back on the relay, the removed arcs are removed again: the same
			// results survive as before the round trip.
			const results = (pass: string) =>
				(JSON.parse(pass) as Message[])
					.filter((m) => m.role === "toolResult")
					.map((m) => m.toolCallId);
			expect(results(JSON.stringify(relayAgain))).toEqual(results(relayDefer));
		} finally {
			f.close();
		}
	}, 60_000);

	it("unreadable removal markers keep pairs without stranding, byte-stable across defer passes", async () => {
		const f = fixture("issue-586-unreadable");
		try {
			await f.dropAndDiscover();
			f.db
				.prepare(
					"UPDATE session_meta SET trailing_blank_decisions = ? WHERE session_id = ?",
				)
				.run(
					'{"version":2,"trailingBlank":{},"piNative":{"toolInputs":"{","reasoningIds":[]}}',
					f.session,
				);
			const first = await f.pass(0);
			expect(orphanToolResults(first)).toEqual([]);
			const second = await f.pass(0);
			expect(orphanToolResults(second)).toEqual([]);
			expect(JSON.stringify(second)).toBe(JSON.stringify(first));
			expect(JSON.stringify(await f.pass(0))).toBe(JSON.stringify(first));
		} finally {
			f.close();
		}
	}, 60_000);

	it("a session poisoned before the fix never strands a result and forgets the poisoned ids on a busting pass", async () => {
		const f = fixture("issue-586-heal");
		try {
			await f.dropAndDiscover();
			// The state issue 586 reports: frozen ids whose dropped arcs now replay
			// as real-argument skeletons, so each frozen message owns a live call.
			const stripped = getStrippedPlaceholderIds(f.db, f.session);
			expect(stripped.size).toBeGreaterThan(0);
			for (const tag of getTagsBySession(f.db, f.session))
				if (tag.type === "tool" && tag.status === "dropped")
					updateTagDropMode(f.db, f.session, tag.tagNumber, "skeleton_real");

			// Defer passes keep every call owner and leave the stored ids alone.
			const deferA = await f.pass(0);
			expect(orphanToolResults(deferA)).toEqual([]);
			expect(responsesWireOrphans(deferA)).toEqual([]);
			expect(JSON.stringify(await f.pass(0))).toBe(JSON.stringify(deferA));
			expect(getStrippedPlaceholderIds(f.db, f.session)).toEqual(stripped);

			// The first pass that already busts forgets the poisoned ids.
			const healed = await f.pass(0, { refresh: true });
			expect(orphanToolResults(healed)).toEqual([]);
			expect(responsesWireOrphans(healed)).toEqual([]);
			expect(getStrippedPlaceholderIds(f.db, f.session).size).toBe(0);
			const after = await f.pass(0);
			expect(orphanToolResults(after)).toEqual([]);
			expect(JSON.stringify(await f.pass(0))).toBe(JSON.stringify(after));
		} finally {
			f.close();
		}
	}, 60_000);
});
