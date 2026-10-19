import { expect, test } from "bun:test";
import { getTagsBySession } from "@magic-context/core/features/magic-context/storage";
import { createTagger } from "@magic-context/core/features/magic-context/tagger";
import { applyFlushedStatuses } from "@magic-context/core/hooks/magic-context/apply-operations";
import { tagTranscript } from "@magic-context/core/shared/tag-transcript";
import { applyPiHeuristicCleanup } from "./heuristic-cleanup-pi";
import {
	assistantMessage,
	createTestDb,
	toolResultMessage,
	userMessage,
} from "./test-utils.test";
import { createPiTranscript } from "./transcript-pi";

function fixture(count = 4) {
	const db = createTestDb();
	const session = "stale-persistence";
	const messages: unknown[] = [userMessage("older", 1)];
	for (let i = 1; i <= count; i++) {
		messages.push(
			{
				role: "assistant",
				timestamp: i * 3,
				content: [
					{
						type: "toolCall",
						id: `reduce-${i}`,
						name: "ctx_reduce",
						arguments: {},
					},
				],
			},
			{
				...toolResultMessage(`reduce-${i}`, "reduced tags", i * 3 + 1),
				toolName: "ctx_reduce",
				content: [
					{ type: "text", text: "reduced tags" },
					{
						type: "image",
						mimeType: "image/png",
						data: "STALE_IMAGE".repeat(30),
					},
				],
			},
		);
	}
	messages.push(userMessage("latest", 100), assistantMessage("answer", 101));
	const tagger = createTagger();
	tagger.initFromDb(session, db);
	const initial = createPiTranscript(messages, session);
	tagTranscript(session, initial, tagger, db);
	initial.commit();
	const raw = structuredClone(messages);
	const transcript = createPiTranscript(messages, session);
	const { targets } = tagTranscript(session, transcript, tagger, db);
	const toolTags = getTagsBySession(db, session).filter(
		(tag) => tag.type === "tool",
	);
	for (const tag of toolTags)
		targets.get(tag.tagNumber)!.cannotRemove = () => true;
	return { db, session, messages, raw, transcript, targets, toolTags, tagger };
}

function cleanup(f: ReturnType<typeof fixture>) {
	return applyPiHeuristicCleanup(f.session, f.db, f.targets, f.messages, {
		protectedTags: 2,
		staleReduceStripEnabled: true,
	});
}

function abortStatus(f: ReturnType<typeof fixture>, call = "reduce-1") {
	f.db.exec(`CREATE TEMP TRIGGER abort_stale_status BEFORE UPDATE OF status ON tags
		WHEN NEW.message_id = '${call}' AND NEW.status = 'dropped'
		BEGIN SELECT RAISE(ABORT, 'abort stale status'); END`);
}

test("stale-reduce persistence: valid drop removes media and persists its replay mode", () => {
	const f = fixture();
	try {
		expect(cleanup(f).droppedStaleReduceCalls).toBe(1);
		f.transcript.commit();
		const tag = getTagsBySession(f.db, f.session).find(
			(tag) => tag.messageId === "reduce-1",
		)!;
		expect([tag.status, tag.dropMode]).toEqual(["dropped", "skeleton_real"]);
		expect(JSON.stringify(f.messages[2])).not.toContain("STALE_IMAGE");
	} finally {
		f.db.close();
	}
});

test("stale-reduce persistence: failed status write leaves transcript intact", () => {
	const f = fixture();
	try {
		const before = JSON.stringify(f.messages);
		abortStatus(f);
		expect(() => cleanup(f)).toThrow("abort stale status");
		f.transcript.commit();
		const tag = getTagsBySession(f.db, f.session).find(
			(tag) => tag.messageId === "reduce-1",
		)!;
		expect(tag.status).toBe("active");
		expect(tag.dropMode).toBe(f.toolTags[0].dropMode);
		expect(JSON.stringify(f.messages)).toBe(before);
	} finally {
		f.db.close();
	}
});

test("stale-reduce persistence: second write failure stops the batch and defer replays only the committed first drop", () => {
	const f = fixture(6);
	try {
		abortStatus(f, "reduce-2");
		expect(() => cleanup(f)).toThrow("abort stale status");
		f.transcript.commit();
		const tags = getTagsBySession(f.db, f.session);
		expect(
			tags.filter((tag) => tag.type === "tool").map((tag) => tag.status),
		).toEqual(["dropped", "active", "active", "active", "active", "active"]);
		expect(JSON.stringify(f.messages[2])).not.toContain("STALE_IMAGE");
		expect(f.messages.slice(3)).toEqual(f.raw.slice(3));

		const deferred = createPiTranscript(f.raw, f.session);
		const { targets } = tagTranscript(f.session, deferred, f.tagger, f.db);
		applyFlushedStatuses(f.session, f.db, targets, tags);
		deferred.commit();
		expect(f.raw).toEqual(f.messages);
	} finally {
		f.db.close();
	}
});
