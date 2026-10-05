import { expect, it } from "bun:test";
import { Database } from "@magic-context/core/shared/sqlite";
import { readPiHistorianTail } from "./historian-tail-pi";
import {
	convertEntriesToRawMessagePage,
	convertEntriesToRawMessages,
	countPiRawMessages,
} from "./read-session-pi";

it("historian tail pages from the proven anchor without hydrating historical tool content", () => {
	const db = new Database(":memory:");
	db.exec(
		"CREATE TABLE compartments (session_id TEXT, sequence INTEGER, end_message INTEGER, end_message_id TEXT, rebase_status TEXT); INSERT INTO compartments VALUES ('session', 1, 4, 'tail', 'resolved')",
	);
	let contentReads = 0;
	const entries = [
		{ type: "message", id: "user", message: { role: "user", content: "old" } },
		{
			type: "message",
			id: "tool",
			message: {
				role: "toolResult",
				toolCallId: "call",
				get content() {
					contentReads++;
					return [{ type: "text", text: "old output" }];
				},
			},
		},
		{
			type: "message",
			id: "assistant",
			message: { role: "assistant", content: [] },
		},
		{ type: "message", id: "tail", message: { role: "user", content: "tail" } },
		{ type: "message", id: "new", message: { role: "assistant", content: [] } },
	];
	let fullReads = 0;
	const provider = {
		readMessages: () => {
			fullReads++;
			return convertEntriesToRawMessages(entries);
		},
		readMessagePage: (after: number, limit: number, watermark: number) =>
			convertEntriesToRawMessagePage(entries, after, limit, watermark),
		getMessageCount: () => countPiRawMessages(entries),
	};
	try {
		const tail = readPiHistorianTail(db, "session", provider);
		expect(tail.absoluteMessageCount).toBe(5);
		expect(contentReads).toBe(0);
		expect(fullReads).toBe(0);
		expect(tail.messages.map((message) => message.id)).toEqual(["tail", "new"]);
		expect(tail.messages).toEqual(
			convertEntriesToRawMessages(entries).slice(3),
		);
		db.exec("UPDATE compartments SET end_message_id = 'missing'");
		expect(readPiHistorianTail(db, "session", provider).messages).toHaveLength(
			5,
		);
		expect(fullReads).toBe(1);
	} finally {
		db.close();
	}
});

it("raw ordinal counts match full conversion across folded tool arcs and protocol entries", () => {
	const roles = [
		"user",
		"assistant",
		"toolResult",
		"system",
		"toolResult",
		"user",
		"toolResult",
		"assistant",
		"toolResult",
	];
	for (let length = 0; length <= roles.length; length++) {
		const entries = roles.slice(0, length).map((role, index) => ({
			type: "message",
			id: String(index),
			message: { role, content: [], toolCallId: "call" },
		}));
		expect(countPiRawMessages(entries)).toBe(
			convertEntriesToRawMessages(entries).length,
		);
	}
});
