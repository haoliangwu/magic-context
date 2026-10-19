import { afterEach, expect, test } from "bun:test";
import {
	getTagsBySession,
	updateTagStatus,
} from "@magic-context/core/features/magic-context/storage";
import { closeQuietly } from "@magic-context/core/shared/sqlite-helpers";
import {
	__test,
	clearContextHandlerSession,
	registerPiContextHandler,
	trackSessionForProject,
} from "./context-handler";
import {
	assistantMessage,
	assistantToolCall,
	createFakePi,
	createTestDb,
	fakeContext,
	type PiMessage,
	textOf,
	toolResultMessage,
	userMessage,
} from "./test-utils.test";

// Header-only restoration must not choose one of multiple event messages with
// the same header; these cases guard that, alongside lifecycle controls.
const review = test;
const sessions: string[] = [];
afterEach(() => {
	for (const id of sessions.splice(0)) clearContextHandlerSession(id);
});

function prose(body: string, timestamp: number) {
	const message = assistantMessage(body, timestamp);
	if (message.role !== "assistant")
		throw new Error("expected an assistant fixture");
	return message;
}

function remember(sessionId: string, message: PiMessage) {
	sessions.push(sessionId);
	__test.recordSuccessfulTaggedMessageIds(
		sessionId,
		["old-assistant"],
		[{ type: "message", id: "old-assistant", message }],
	);
	return fakeContext(sessionId);
}

review(
	"retained review partner: an unchanged unique retained message keeps its entry id",
	() => {
		const id = "retained-review-unique";
		const old = prose("original prose", 2);
		const ctx = remember(id, old);
		expect(
			__test.resolvePiEventEntryIds(
				ctx as never,
				[structuredClone(old)],
				id,
				[],
			),
		).toEqual(["old-assistant"]);
	},
);

review(
	"retained review partner: two remembered header owners stay unresolved",
	() => {
		const id = "retained-review-remembered-twins";
		sessions.push(id);
		const old = prose("original prose", 2);
		__test.recordSuccessfulTaggedMessageIds(
			id,
			["one", "two"],
			[
				{ type: "message", id: "one", message: old },
				{ type: "message", id: "two", message: structuredClone(old) },
			],
		);
		expect(
			__test.resolvePiEventEntryIds(
				fakeContext(id) as never,
				[structuredClone(old)],
				id,
				[],
			),
		).toEqual([undefined]);
	},
);

review(
	"retained review partner: branch switch and revert with projected entries keep their own ids",
	() => {
		const id = "retained-review-tree";
		const old = prose("branch A prose", 2);
		const ctx = remember(id, old);
		const other = prose("branch B prose", 2);
		const entries = [{ type: "message", id: "branch-b", message: other }];
		expect(
			__test.resolvePiEventEntryIds(
				ctx as never,
				[structuredClone(other)],
				id,
				entries,
			),
		).toEqual(["branch-b"]);
		__test.recordSuccessfulTaggedMessageIds(id, ["branch-b"], entries);
		expect(
			__test.resolvePiEventEntryIds(ctx as never, [structuredClone(old)], id, [
				{ type: "message", id: "old-assistant", message: old },
			]),
		).toEqual(["old-assistant"]);
	},
);

review(
	"retained review partner: the retained window replaces old ids and session clear removes it",
	() => {
		const id = "retained-review-bounded";
		const old = prose("original prose", 2);
		const ctx = remember(id, old);
		for (let index = 0; index < 1_000; index++) {
			const entryId = `entry-${index}`;
			__test.recordSuccessfulTaggedMessageIds(
				id,
				[entryId],
				[
					{
						type: "message",
						id: entryId,
						message: prose("new prose", index + 3),
					},
				],
			);
			expect([...__test.getTaggedStableMessageIdsForTests(id)]).toEqual([
				entryId,
			]);
		}
		expect(__test.resolvePiEventEntryIds(ctx as never, [old], id, [])).toEqual([
			undefined,
		]);
		expect(
			__test.resolvePiEventEntryIds(
				ctx as never,
				[prose("new prose", 1_002)],
				id,
				[],
			),
		).toEqual(["entry-999"]);
		__test.recordSuccessfulTaggedMessageIds(
			id,
			["old-assistant"],
			[{ type: "message", id: "old-assistant", message: old }],
		);
		clearContextHandlerSession(id);
		expect(__test.resolvePiEventEntryIds(ctx as never, [old], id, [])).toEqual([
			undefined,
		]);
	},
);

review(
	"retained review partner: changed prose is not dropped and three restored passes do not refuse or retag it",
	async () => {
		const id = "retained-review-content-drift";
		sessions.push(id);
		const db = createTestDb();
		try {
			const fake = createFakePi();
			registerPiContextHandler(fake.pi as never, { db });
			const handler = fake.handlers.get("context") as (
				event: { messages: PiMessage[] },
				ctx: unknown,
			) => Promise<{ messages: PiMessage[] }>;
			const old = prose("original prose ".repeat(100), 2);
			const current = userMessage("continue", 3);
			const ctx = fakeContext(id);
			let entries = [
				{ type: "message", id: "old-assistant", message: old },
				{ type: "message", id: "live-user", message: current },
			];
			ctx.sessionManager.getBranch = () => entries;
			await handler({ messages: structuredClone([old, current]) }, ctx);
			const tag = getTagsBySession(db, id).find(
				(row) => row.messageId === "old-assistant:p0",
			);
			expect(tag).toBeDefined();
			if (!tag) throw new Error("missing fixture tag");
			updateTagStatus(db, id, tag.tagNumber, "dropped");
			entries = [{ type: "message", id: "live-user", message: current }];
			const replacement = structuredClone(old);
			const newBody = "rewritten prose ".repeat(100);
			replacement.content = [{ type: "text", text: newBody }];
			let previous: string | undefined;
			for (let pass = 0; pass < 3; pass++) {
				const result = await handler(
					{ messages: structuredClone([replacement, current]) },
					ctx,
				);
				const bytes = JSON.stringify(result.messages);
				expect(bytes).toContain(newBody);
				if (previous !== undefined) expect(bytes).toBe(previous);
				previous = bytes;
			}
			expect(
				getTagsBySession(db, id).find((row) => row.tagNumber === tag.tagNumber)
					?.status,
			).toBe("dropped");
		} finally {
			closeQuietly(db);
		}
	},
);

review(
	"retained review partner: tracked-session eviction clears the oldest retained window",
	() => {
		const id = "retained-review-evicted";
		const old = prose("original prose", 2);
		const ctx = remember(id, old);
		trackSessionForProject("", id);
		for (let index = 0; index < 100; index++) {
			const next = `${id}-${index}`;
			sessions.push(next);
			trackSessionForProject("", next);
		}
		expect(__test.resolvePiEventEntryIds(ctx as never, [old], id, [])).toEqual([
			undefined,
		]);
	},
);

for (const responseId of [undefined, "same-response"]) {
	review(
		`retained review: a formerly unique ${responseId ? "response id" : "millisecond"} must not identify the first of two event messages`,
		() => {
			const id = `retained-review-duplicate-${responseId ?? "timestamp"}`;
			const old = {
				...prose("original prose", 2),
				...(responseId ? { responseId } : {}),
			};
			const ctx = remember(id, old);
			const replacement = structuredClone(old);
			replacement.content = [{ type: "text", text: "different new prose" }];
			const current = userMessage("continue", 3);
			const entries = [{ type: "message", id: "live-user", message: current }];
			const resolved = __test.resolvePiEventEntryIds(
				ctx as never,
				[replacement, structuredClone(old), current],
				id,
				entries,
			);
			expect(resolved).toEqual([undefined, undefined, "live-user"]);
		},
	);
}

review(
	"retained review: two same-header event twins must not replay a saved drop onto an ambiguous slot",
	async () => {
		const id = "retained-review-drop-transfer";
		sessions.push(id);
		const db = createTestDb();
		try {
			const fake = createFakePi();
			registerPiContextHandler(fake.pi as never, { db });
			const handler = fake.handlers.get("context") as (
				event: { messages: PiMessage[] },
				ctx: unknown,
			) => Promise<{ messages: PiMessage[] }>;
			const newBody = "original prose ".repeat(100);
			const old = prose(newBody, 2);
			const current = userMessage("continue", 3);
			const ctx = fakeContext(id);
			let entries = [
				{ type: "message", id: "old-assistant", message: old },
				{ type: "message", id: "live-user", message: current },
			];
			ctx.sessionManager.getBranch = () => entries;
			await handler({ messages: structuredClone([old, current]) }, ctx);
			const tag = getTagsBySession(db, id).find(
				(row) => row.messageId === "old-assistant:p0",
			);
			expect(tag).toBeDefined();
			if (!tag) throw new Error("missing fixture tag");
			updateTagStatus(db, id, tag.tagNumber, "dropped");
			entries = [{ type: "message", id: "live-user", message: current }];
			const replacement = structuredClone(old);
			replacement.content = [{ type: "text", text: newBody }];
			const result = await handler(
				{ messages: structuredClone([replacement, old, current]) },
				ctx,
			);
			const servedTwins = result.messages.filter((message) =>
				textOf(message).includes(newBody),
			);
			expect(servedTwins).toHaveLength(2);
		} finally {
			closeQuietly(db);
		}
	},
);

review(
	"retained review: duplicate-header tool owners must not give a new call the old call's dropped tag",
	async () => {
		const id = "retained-review-tool-transfer";
		sessions.push(id);
		const db = createTestDb();
		try {
			const fake = createFakePi();
			registerPiContextHandler(fake.pi as never, { db });
			const handler = fake.handlers.get("context") as (
				event: { messages: PiMessage[] },
				ctx: unknown,
			) => Promise<{ messages: PiMessage[] }>;
			const old = assistantToolCall(
				"reused-call",
				"Read",
				{ path: "old.txt" },
				2,
			);
			const oldResult = toolResultMessage("reused-call", "old output", 3);
			const current = userMessage("continue", 4);
			const ctx = fakeContext(id);
			let entries = [old, oldResult, current].map((message, index) => ({
				type: "message",
				id: ["old-assistant", "old-result", "live-user"][index] as string,
				message,
			}));
			ctx.sessionManager.getBranch = () => entries;
			await handler(
				{ messages: structuredClone([old, oldResult, current]) },
				ctx,
			);
			const tag = getTagsBySession(db, id).find((row) => row.type === "tool");
			expect(tag).toBeDefined();
			if (!tag) throw new Error("missing fixture tool tag");
			updateTagStatus(db, id, tag.tagNumber, "dropped");
			entries = [{ type: "message", id: "live-user", message: current }];
			const replacement = assistantToolCall(
				"reused-call",
				"Read",
				{ path: "NEW_INVOCATION.txt" },
				2,
			);
			const replacementResult = toolResultMessage(
				"reused-call",
				"NEW_INVOCATION output",
				3,
			);
			const result = await handler(
				{
					messages: structuredClone([
						replacement,
						replacementResult,
						old,
						oldResult,
						current,
					]),
				},
				ctx,
			);
			expect(JSON.stringify(result.messages)).toContain("NEW_INVOCATION");
		} finally {
			closeQuietly(db);
		}
	},
);
