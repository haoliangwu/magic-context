import { describe, expect, it } from "bun:test";
import type { RawMessage } from "@magic-context/core/hooks/magic-context/read-session-raw";
import type { Database } from "@magic-context/core/shared/sqlite";
import { schedulePiAssistantIndexOnMessageEnd } from "./message-end-index-pi";
import {
	convertEntriesToRawMessages,
	convertPiAssistantEntryById,
} from "./read-session-pi";

type Source =
	| RawMessage
	| ((sessionId: string, messageId: string) => RawMessage | null);

function harness() {
	const entries: Array<{ type: string; id: string; message: unknown }> = [
		{
			type: "message",
			id: "entry-user",
			message: { role: "user", content: "question", timestamp: 1 },
		},
	];
	const scheduled: Array<{ messageId: string; source: Source }> = [];
	const schedule = ((
		_db: Database,
		_sessionId: string,
		messageId: string,
		source: Source,
	) => {
		scheduled.push({ messageId, source });
	}) as never;
	const session = {
		readBranch: () => entries,
		readMessages: () => convertEntriesToRawMessages(entries),
	};
	const resolve = (item: { messageId: string; source: Source }) =>
		typeof item.source === "function"
			? item.source("ses", item.messageId)
			: item.source;
	return { entries, scheduled, schedule, session, resolve };
}

describe("schedulePiAssistantIndexOnMessageEnd", () => {
	it("converts only the ended assistant and preserves its folded ordinal and metadata", () => {
		const ended = {
			role: "assistant",
			content: [{ type: "text", text: "answer" }],
			timestamp: 4,
		};
		const entries = [
			{
				type: "message",
				id: "user",
				message: { role: "user", content: "question", timestamp: 1 },
			},
			{
				type: "message",
				id: "tool",
				message: {
					role: "toolResult",
					toolCallId: "call",
					content: [{ type: "text", text: "result" }],
					timestamp: 2,
				},
			},
			{
				type: "message",
				id: "protocol",
				message: { role: "bashExecution", content: "ignored", timestamp: 3 },
			},
			{
				type: "message",
				id: "assistant",
				message: ended,
				timestamp: "2026-01-01T00:00:00.000Z",
			},
		];
		const expected = convertEntriesToRawMessages(entries).find(
			(message) => message.id === "assistant",
		);
		let historicalReads = 0;
		Object.defineProperty(entries[0].message, "content", {
			get() {
				historicalReads++;
				return "question";
			},
		});
		expect(convertPiAssistantEntryById(entries, "assistant")).toEqual(expected);
		expect(historicalReads).toBe(0);
		expect(convertPiAssistantEntryById(entries, "absent")).toBeNull();
	});
	it("indexes a Pi assistant message, which carries no id of its own", () => {
		const { entries, scheduled, schedule, session, resolve } = harness();
		// Pi's AssistantMessage has no `id`; the session entry id is assigned
		// when Pi persists the message, after extension message_end handlers
		// have run (agent-session.js: _emitExtensionEvent, then appendMessage).
		const ended = {
			role: "assistant",
			content: [{ type: "text", text: "the answer" }],
			stopReason: "stop",
			timestamp: 2,
		};

		schedulePiAssistantIndexOnMessageEnd(
			{} as Database,
			"ses",
			ended,
			session,
			{ schedule },
		);
		entries.push({ type: "message", id: "entry-assistant", message: ended });

		expect(scheduled).toHaveLength(1);
		const raw = resolve(scheduled[0]);
		expect(raw?.id).toBe("entry-assistant");
		expect(raw?.role).toBe("assistant");
		expect(raw?.parts).toEqual([{ type: "text", text: "the answer" }]);
	});

	it("uses the entry id directly when the host persisted the message first", () => {
		const { entries, scheduled, schedule, session, resolve } = harness();
		const ended = {
			role: "assistant",
			content: [{ type: "text", text: "already stored" }],
			stopReason: "stop",
			timestamp: 2,
		};
		entries.push({ type: "message", id: "entry-assistant", message: ended });

		schedulePiAssistantIndexOnMessageEnd(
			{} as Database,
			"ses",
			ended,
			session,
			{ schedule },
		);

		expect(scheduled.map((item) => item.messageId)).toEqual([
			"entry-assistant",
		]);
		expect(resolve(scheduled[0])?.id).toBe("entry-assistant");
	});

	it("ignores non-assistant messages", () => {
		const { scheduled, schedule, session } = harness();

		schedulePiAssistantIndexOnMessageEnd(
			{} as Database,
			"ses",
			{ role: "toolResult", toolCallId: "c1", content: [] },
			session,
			{ schedule },
		);

		expect(scheduled).toHaveLength(0);
	});
});
