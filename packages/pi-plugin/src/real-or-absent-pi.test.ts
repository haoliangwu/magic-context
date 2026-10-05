/// <reference types="bun-types" />

import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import {
	getTagsBySession,
	queuePendingOp,
} from "@magic-context/core/features/magic-context/storage";
import { createTagger } from "@magic-context/core/features/magic-context/tagger";
import {
	applyFlushedStatuses,
	applyPendingOperations,
} from "@magic-context/core/hooks/magic-context/apply-operations";
import {
	isSmallToolInput,
	SKELETON_REAL_INPUT_MAX_BYTES,
	toolInputStringBytes,
} from "@magic-context/core/hooks/magic-context/tool-input-size";
import { tagTranscript } from "@magic-context/core/shared/tag-transcript";
import fixture from "../../../tests/fixtures/tool-input-string-bytes.json";
import { createPiDroppedInputGuard } from "./dropped-input-guard-pi";
import { createTestDb } from "./test-utils.test";
import { createPiTranscript } from "./transcript-pi";

const SESSION = "ses-real-or-absent";

const call = (id: string, args: Record<string, unknown>) => ({
	role: "assistant",
	timestamp: 1,
	content: [{ type: "toolCall", id, name: "write", arguments: args }],
});
const result = (id: string, text: string) => ({
	role: "toolResult",
	toolCallId: id,
	toolName: "write",
	content: [{ type: "text", text }],
	timestamp: 2,
});
const user = (text: string) => ({ role: "user", content: text, timestamp: 3 });

type Db = ReturnType<typeof createTestDb>;

function toolTag(db: Db, callId: string): number {
	const tag = getTagsBySession(db, SESSION).find(
		(entry) => entry.type === "tool" && entry.messageId === callId,
	);
	if (!tag) throw new Error(`no tag for ${callId}`);
	return tag.tagNumber;
}

/** One provider pass over a copy of `source`; drops `dropCallIds` first when given. */
function serve(db: Db, source: unknown[], dropCallIds?: string[]): unknown[] {
	const messages = structuredClone(source);
	const transcript = createPiTranscript(messages as never, SESSION);
	const tagger = createTagger();
	tagger.initFromDb(SESSION, db);
	const { targets } = tagTranscript(SESSION, transcript, tagger, db);
	if (dropCallIds) {
		for (const id of dropCallIds)
			queuePendingOp(db, SESSION, toolTag(db, id), "drop");
		applyPendingOperations(SESSION, db, targets, new Set());
	} else {
		applyFlushedStatuses(SESSION, db, targets);
	}
	transcript.commit();
	transcript.finalizeToolRemovals();
	return messages;
}

function callArguments(messages: unknown[], callId: string): unknown {
	for (const message of messages as Array<{ content?: unknown }>) {
		if (!Array.isArray(message.content)) continue;
		for (const part of message.content as Array<Record<string, unknown>>) {
			if (part.type === "toolCall" && part.id === callId) return part.arguments;
		}
	}
	return undefined;
}

function resultText(messages: unknown[], callId: string): string | undefined {
	const found = (messages as Array<Record<string, unknown>>).find(
		(message) => message.role === "toolResult" && message.toolCallId === callId,
	);
	const content = found?.content as Array<{ text?: string }> | undefined;
	return content?.map((part) => part.text ?? "").join("");
}

describe("Pi tool input size", () => {
	it("matches the shared cross-lane fixture", () => {
		expect(fixture.max_small_bytes).toBe(SKELETON_REAL_INPUT_MAX_BYTES);
		for (const testCase of fixture.cases) {
			expect({
				name: testCase.name,
				bytes: toolInputStringBytes(testCase.input),
			}).toEqual({ name: testCase.name, bytes: testCase.expected_bytes });
			expect(isSmallToolInput(testCase.input)).toBe(testCase.expected_small);
		}
	});
});

describe("Pi real-or-absent drops inside the newest-call window", () => {
	it("keeps real arguments at 1024 bytes and removes the call at 1025", () => {
		const db = createTestDb();
		try {
			const at = { content: "a".repeat(1024) };
			const over = { content: "a".repeat(1025) };
			const source = [
				user("start"),
				call("call-1024", at),
				result("call-1024", "out 1024"),
				call("call-1025", over),
				result("call-1025", "out 1025"),
				user("next prompt"),
			];
			const served = serve(db, source, ["call-1024", "call-1025"]);
			const small = toolTag(db, "call-1024");
			const large = toolTag(db, "call-1025");
			const modes = new Map(
				getTagsBySession(db, SESSION).map((tag) => [
					tag.tagNumber,
					tag.dropMode,
				]),
			);
			expect(modes.get(small)).toBe("skeleton_real");
			expect(modes.get(large)).toBe("full");
			expect(callArguments(served, "call-1024")).toEqual(at);
			expect(resultText(served, "call-1024")).toBe(`[dropped §${small}§]`);
			expect(callArguments(served, "call-1025")).toBeUndefined();
			expect(resultText(served, "call-1025")).toBeUndefined();
		} finally {
			db.close();
		}
	});

	it("keeps the call whose result ends the request, with its real arguments", () => {
		const db = createTestDb();
		try {
			const large = { content: "b".repeat(5000) };
			const served = serve(
				db,
				[user("start"), call("call-end", large), result("call-end", "out")],
				["call-end"],
			);
			const tag = toolTag(db, "call-end");
			expect(
				getTagsBySession(db, SESSION).find((entry) => entry.tagNumber === tag)
					?.dropMode,
			).toBe("skeleton_real");
			expect(callArguments(served, "call-end")).toEqual(large);
			expect(resultText(served, "call-end")).toBe(`[dropped §${tag}§]`);
			expect(JSON.stringify(served)).not.toContain('"dropped":');
		} finally {
			db.close();
		}
	});

	it("serves the same bytes over the shared prefix on the next defer pass", () => {
		const db = createTestDb();
		try {
			const base = [
				user("start"),
				call("call-small", { command: "ls -la" }),
				result("call-small", "listing"),
				call("call-mid", { content: "m".repeat(2000) }),
				result("call-mid", "mid"),
				call("call-large", { content: "c".repeat(3000) }),
				result("call-large", "large"),
			];
			const passA = serve(db, base, ["call-small", "call-mid", "call-large"]);
			// Rule 1 (small), rule 2 (large, removed), rule 3 (large, ends the request).
			expect(callArguments(passA, "call-small")).toEqual({ command: "ls -la" });
			expect(callArguments(passA, "call-mid")).toBeUndefined();
			expect(callArguments(passA, "call-large")).toEqual({
				content: "c".repeat(3000),
			});
			const passB = serve(db, [...base, user("a newer message")]);
			const sha = (messages: unknown[]) =>
				createHash("sha256").update(JSON.stringify(messages)).digest("hex");
			expect(passB.length).toBe(passA.length + 1);
			expect(sha(passB.slice(0, passA.length))).toBe(sha(passA));
		} finally {
			db.close();
		}
	});

	it("lets a copied real-argument call through the Pi dropped-input guard", () => {
		const db = createTestDb();
		try {
			const args = { path: "/tmp/notes.txt", content: "hello" };
			const served = serve(
				db,
				[
					user("start"),
					call("call-copy", args),
					result("call-copy", "ok"),
					user("next"),
				],
				["call-copy"],
			);
			const copied = callArguments(served, "call-copy") as Record<
				string,
				unknown
			>;
			expect(copied).toEqual(args);
			expect(
				createPiDroppedInputGuard()({
					type: "tool_call",
					toolCallId: "call-new",
					toolName: "write",
					input: copied,
				}),
			).toBeUndefined();
		} finally {
			db.close();
		}
	});
});
