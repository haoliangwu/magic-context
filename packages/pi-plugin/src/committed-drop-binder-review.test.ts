import { expect, test } from "bun:test";
import {
	getTagsBySession,
	insertTag,
} from "@magic-context/core/features/magic-context/storage";
import { applyFlushedStatuses } from "@magic-context/core/hooks/magic-context/apply-operations";
import { buildPersistedDropTargets } from "@magic-context/core/shared/tag-transcript";
import {
	assistantMessage,
	assistantToolCall,
	createTestDb,
	toolResultMessage,
	userMessage,
} from "./test-utils.test";
import { createPiTranscript } from "./transcript-pi";

const session = "independent-pi-binder";
for (const mode of ["full", "truncated", "skeleton_real"]) {
	test(`independent Pi binder legacy ${mode}: split native results, synth-user and idempotence`, () => {
		const db = createTestDb();
		try {
			insertTag(db, session, "call", "tool", 100, 817, 0, "read", 0, "owner");
			db.prepare(
				"UPDATE tags SET status='dropped',drop_mode=? WHERE session_id=?",
			).run(mode, session);
			const messages = [
				userMessage("start"),
				assistantToolCall("call", "read", { filePath: "real.ts" }, 2),
				toolResultMessage("call", "first segment", 3),
				toolResultMessage("call", "second segment", 4),
				userMessage("next", 5),
			];
			const ids = ["start", "owner", "result-a", "result-b", "synth-user-last"];
			const tags = getTagsBySession(db, session);
			const replay = () => {
				const transcript = createPiTranscript(messages, session, ids);
				applyFlushedStatuses(
					session,
					db,
					buildPersistedDropTargets(transcript, tags),
					tags,
				);
				transcript.commit();
				transcript.finalizeToolRemovals();
			};
			replay();
			const wire = JSON.stringify(messages);
			expect(wire).not.toContain("first segment");
			expect(wire).not.toContain("second segment");
			if (mode === "full")
				expect(messages).toEqual([
					userMessage("start"),
					userMessage("next", 5),
				]);
			else {
				expect(wire).toContain("[dropped §817§]");
				expect(wire.includes("real.ts")).toBe(mode === "skeleton_real");
			}
			replay();
			expect(JSON.stringify(messages)).toBe(wire);
			expect(getTagsBySession(db, session)).toEqual(tags);
		} finally {
			db.close();
		}
	});
}
for (const id of ["synth-user-old:p0", "absent-from-request"]) {
	test(`independent Pi binder text ${id}: visible number binds without allocating identity`, () => {
		const db = createTestDb();
		try {
			insertTag(db, session, id, "message", 100, 817);
			db.exec("UPDATE tags SET status='dropped'");
			const messages = [userMessage("§817§ old text"), userMessage("next", 2)];
			const transcript = createPiTranscript(messages, session, [
				"synth-user-old",
				"tail",
			]);
			const tags = getTagsBySession(db, session);
			applyFlushedStatuses(
				session,
				db,
				buildPersistedDropTargets(transcript, tags),
				tags,
			);
			transcript.commit();
			expect(JSON.stringify(messages)).toContain("[dropped §817§]");
			expect(getTagsBySession(db, session)).toEqual(tags);
		} finally {
			db.close();
		}
	});
}
test("review P1 Pi signed-prefix invariant: committed text before kept thinking must strip or refuse", () => {
	const db = createTestDb();
	try {
		insertTag(db, session, "old:p0", "message", 100, 817);
		db.exec("UPDATE tags SET status='dropped'");
		const messages = [
			userMessage("§817§ old text"),
			assistantMessage("answer", 2, {
				api: "anthropic-messages",
				provider: "anthropic",
				model: "claude-sonnet-4",
				content: [
					{
						type: "thinking",
						thinking: "keep",
						thinkingSignature: "signed-prefix",
					},
					{ type: "text", text: "answer" },
				],
			}),
			userMessage("next", 3),
		];
		const before = JSON.stringify(messages[0]);
		const transcript = createPiTranscript(messages, session, [
			"old",
			"signed",
			"tail",
		]);
		const tags = getTagsBySession(db, session);
		applyFlushedStatuses(
			session,
			db,
			buildPersistedDropTargets(transcript, tags),
			tags,
		);
		transcript.commit();
		expect(
			JSON.stringify(messages).includes("signed-prefix") &&
				JSON.stringify(messages[0]) !== before,
		).toBe(false);
	} finally {
		db.close();
	}
});

for (const owner of [null, "older"]) {
	test(`Pi binder reused call ID: ${owner ? "qualified owner" : "ambiguous legacy row"}`, () => {
		const db = createTestDb();
		try {
			insertTag(db, session, "call", "tool", 100, 817, 0, "read", 0, owner);
			db.exec("UPDATE tags SET status='dropped'");
			const older = [
				assistantToolCall("call", "read", { filePath: "older.ts" }, 2),
				toolResultMessage("call", "older result", 3),
			];
			const newer = [
				assistantToolCall("call", "read", { filePath: "newer.ts" }, 4),
				toolResultMessage("call", "newer result", 5),
			];
			const messages = [...older, ...newer, userMessage("next", 6)];
			const before = structuredClone(messages);
			const transcript = createPiTranscript(messages, session, [
				"older",
				"older-result",
				"newer",
				"newer-result",
				"tail",
			]);
			const tags = getTagsBySession(db, session);
			applyFlushedStatuses(
				session,
				db,
				buildPersistedDropTargets(transcript, tags),
				tags,
			);
			transcript.commit();
			transcript.finalizeToolRemovals();
			expect(messages).toEqual(
				owner ? [...newer, userMessage("next", 6)] : before,
			);
		} finally {
			db.close();
		}
	});
}
