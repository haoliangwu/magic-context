import { afterEach, expect, test } from "bun:test";
import {
	getTagsBySession,
	updateTagStatus,
} from "@magic-context/core/features/magic-context/storage";
import { closeQuietly } from "@magic-context/core/shared/sqlite-helpers";
import {
	clearContextHandlerSession,
	registerPiContextHandler,
} from "./context-handler";
import {
	assistantMessage,
	createFakePi,
	createTestDb,
	fakeContext,
	userMessage,
} from "./test-utils.test";

const sessions: string[] = [];
afterEach(() => {
	for (const id of sessions.splice(0)) clearContextHandlerSession(id);
});

async function fixture(sessionId: string) {
	sessions.push(sessionId);
	const db = createTestDb();
	const fake = createFakePi();
	registerPiContextHandler(fake.pi as never, { db });
	const handler = fake.handlers.get("context") as (
		event: { messages: never[] },
		ctx: never,
	) => Promise<{ messages: never[] }>;
	const body = "retained assistant prose ".repeat(100);
	const raw = () => [
		userMessage("old question", 1),
		assistantMessage(body, 2),
		userMessage("continue", 3),
	];
	const ids = ["old-user", "old-assistant", "live-user"];
	let entries = ids.map((id, index) => ({
		type: "message",
		id,
		message: raw()[index],
	}));
	const ctx = fakeContext(sessionId);
	ctx.sessionManager.getBranch = () => entries;
	await handler({ messages: raw() as never[] }, ctx as never);
	const tag = getTagsBySession(db, sessionId).find(
		(row) => row.messageId === "old-assistant:p0",
	);
	if (!tag)
		throw new Error("assistant fixture was not tagged under its real entry id");
	updateTagStatus(db, sessionId, tag.tagNumber, "dropped");
	return {
		db,
		body,
		raw,
		ctx,
		handler,
		setEntries: (next: typeof entries) => {
			entries = next;
		},
	};
}

test("retained raw prose replays its saved drop after native branch compaction", async () => {
	const f = await fixture("retained-prose-reclaim");
	try {
		// Oh My Pi's context event can retain raw messages omitted by its branch APIs.
		f.setEntries([{ type: "message", id: "live-user", message: f.raw()[2] }]);
		for (let pass = 0; pass < 3; pass++) {
			const result = await f.handler(
				{ messages: f.raw() as never[] },
				f.ctx as never,
			);
			expect(JSON.stringify(result.messages)).not.toContain(f.body);
			expect(getTagsBySession(f.db, "retained-prose-reclaim")).toHaveLength(3);
		}
	} finally {
		closeQuietly(f.db);
	}
});

test("retained entry headers do not transfer a drop to a different message timestamp", async () => {
	const f = await fixture("retained-prose-new-header");
	try {
		const next = [assistantMessage(f.body, 4), userMessage("new question", 5)];
		f.setEntries(
			next.map((message, index) => ({
				type: "message",
				id: `new-${index}`,
				message,
			})),
		);
		const result = await f.handler(
			{ messages: next as never[] },
			f.ctx as never,
		);
		expect(JSON.stringify(result.messages)).toContain(f.body);
	} finally {
		closeQuietly(f.db);
	}
});

test("ambiguous retained and current entry headers do not inherit the old drop", async () => {
	const f = await fixture("retained-prose-ambiguous");
	try {
		f.setEntries([
			{ type: "message", id: "other-assistant", message: f.raw()[1] },
		]);
		const next = [f.raw()[1], structuredClone(f.raw()[1])];
		const result = await f.handler(
			{ messages: next as never[] },
			f.ctx as never,
		);
		expect(JSON.stringify(result.messages)).toContain(f.body);
		expect(
			getTagsBySession(f.db, "retained-prose-ambiguous").find(
				(row) => row.messageId === "old-assistant:p0",
			)?.status,
		).toBe("dropped");
	} finally {
		closeQuietly(f.db);
	}
});
