import type { ContextDatabase } from "@magic-context/core/features/magic-context/storage";
import { getNativeReplayState } from "@magic-context/core/features/magic-context/storage-native-replay";
import { createTagger } from "@magic-context/core/features/magic-context/tagger";
import {
	type MessageLike,
	tagMessages,
} from "@magic-context/core/hooks/magic-context/tag-messages";
import { tagTranscript } from "@magic-context/core/shared/tag-transcript";
import { adaptPayload } from "../../../../plugin/src/v2/hooks/payload";
import {
	authorizePiToolRemoval,
	preparePiToolRemovalMeasurements,
} from "../../../src/native-replay-state-pi";
import { createPiTranscript } from "../../../src/transcript-pi";

export type DropHost = "pi" | "oc1" | "oc2";
export const session = "queued-drop-fixture";

/** Synthetic completed tool calls, optionally followed by a user turn. */
export function history(host: DropHost, count: number, seed = 0): unknown[] {
	let state = seed || 1;
	const random = () => {
		state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
		return state / 2 ** 32;
	};
	const calls = Array.from({ length: count }, (_, i) => ({
		id: `call-${i}`,
		input: {
			filePath: `file-${i}.ts`,
			content: "x".repeat(random() < 0.5 ? 50 : 4000),
		},
		output: `result-${i}\n`.repeat(80),
	}));
	const tail = seed % 2 === 0;
	if (host === "pi") {
		const messages: unknown[] = [
			{ role: "user", content: "read", timestamp: 1 },
		];
		for (const [i, c] of calls.entries()) {
			messages.push({
				role: "assistant",
				content: [
					{ type: "toolCall", id: c.id, name: "read", arguments: c.input },
				],
				api: "anthropic-messages",
				provider: "anthropic",
				model: "test",
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "toolUse",
				timestamp: i * 2 + 2,
			});
			messages.push({
				role: "toolResult",
				toolCallId: c.id,
				toolName: "read",
				content: [{ type: "text", text: c.output }],
				isError: false,
				timestamp: i * 2 + 3,
			});
		}
		if (tail)
			messages.push({ role: "user", content: "continue", timestamp: 10000 });
		return messages;
	}
	if (host === "oc1")
		return [
			{
				info: { id: "u1", role: "user" },
				parts: [{ type: "text", text: "read" }],
			},
			...calls.map((c) => ({
				info: { id: `owner-${c.id}`, role: "assistant" },
				parts: [
					{
						type: "tool",
						tool: "read",
						callID: c.id,
						state: { status: "completed", input: c.input, output: c.output },
					},
				],
			})),
			...(tail
				? [
						{
							info: { id: "u2", role: "user" },
							parts: [{ type: "text", text: "continue" }],
						},
					]
				: []),
		];
	return [
		{ id: "u1", role: "user", content: [{ type: "text", text: "read" }] },
		...calls.flatMap((c) => [
			{
				id: `owner-${c.id}`,
				role: "assistant",
				content: [
					{ type: "tool-call", id: c.id, name: "read", input: c.input },
				],
			},
			{
				id: `result-${c.id}`,
				role: "tool",
				content: [
					{
						type: "tool-result",
						id: c.id,
						name: "read",
						result: { type: "text", value: c.output },
					},
				],
			},
		]),
		...(tail
			? [
					{
						id: "u2",
						role: "user",
						content: [{ type: "text", text: "continue" }],
					},
				]
			: []),
	];
}

export function project(
	host: DropHost,
	raw: unknown[],
	db: ContextDatabase,
	nativeAuthorization = false,
) {
	const tagger = createTagger();
	tagger.initFromDb(session, db);
	if (host === "pi") {
		const saved = nativeAuthorization
			? getNativeReplayState(db, session).toolInputs
			: undefined;
		const transcript = createPiTranscript(
			raw,
			session,
			undefined,
			nativeAuthorization
				? {
						authorizeToolRemoval: (callId) =>
							authorizePiToolRemoval({
								db,
								sessionId: session,
								callId,
								saved,
								canApply: true,
							}),
						authorizeToolRemovals: (callIds) =>
							preparePiToolRemovalMeasurements({
								db,
								sessionId: session,
								callIds,
								saved,
								canApply: true,
							}),
					}
				: {},
		);
		return {
			...tagTranscript(session, transcript, tagger, db),
			commit: () => transcript.commit(),
		};
	}
	if (host === "oc1") {
		const tagged = tagMessages(session, raw as MessageLike[], tagger, db);
		return { ...tagged, commit: () => tagged.batch.finalize() };
	}
	const draft = {
		sessionID: session,
		model: { providerID: "anthropic", id: "model" },
		agent: "build",
		messages: raw,
		system: [],
		tools: {},
		options: {},
	};
	const adapted = adaptPayload(draft as never);
	const tagged = tagMessages(session, adapted.messages, tagger, db);
	return {
		...tagged,
		commit: () => {
			tagged.batch.finalize();
			adapted.commit();
			raw.splice(0, raw.length, ...draft.messages);
		},
	};
}

export function seedHistory(db: ContextDatabase) {
	const insert = db.prepare(
		"INSERT INTO tags(session_id,tag_number,message_id,type,status,byte_size) VALUES('historical',?,?,'tool','compacted',4000)",
	);
	db.transaction(() => {
		for (let n = 1; n <= 110_000; n++) insert.run(n, `historical-call-${n}`);
	}).immediate();
	db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
}
