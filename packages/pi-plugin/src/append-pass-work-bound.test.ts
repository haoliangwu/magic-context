import { afterEach, describe, expect, it } from "bun:test";
import {
	buildSessionContext,
	type ExtensionContext,
	type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import {
	__test,
	clearContextHandlerSession,
	registerPiContextHandler,
} from "./context-handler";
import { createTestDb } from "./test-utils.test";

// An ordinary append pass must cost the same at 1k and 10k messages. The
// fixture reproduces the production shape that used to hash every message on
// every pass: Pi 0.87 persists a system message entry but withholds system
// messages from `context` handlers, and the session keeps one fallback tag
// that no live message can adopt.

const SESSION_ID = "append-pass-work-bound";

function buildEntries(messageCount: number): SessionEntry[] {
	const entries: SessionEntry[] = [];
	let parentId: string | null = null;
	let timestamp = 1_750_000_000_000;
	const append = (id: string, message: Record<string, unknown>) => {
		entries.push({
			type: "message",
			id,
			parentId,
			timestamp: new Date(timestamp).toISOString(),
			message: { ...message, timestamp },
		} as unknown as SessionEntry);
		parentId = id;
		timestamp += 1_000;
	};
	append("system-entry", {
		role: "system",
		content: "You are a coding agent.",
	});
	for (let index = 0; index < messageCount; index += 1) {
		append(
			`entry-${index}`,
			index % 2 === 0
				? { role: "user", content: `Question ${index} about the codebase.` }
				: {
						role: "assistant",
						content: [{ type: "text", text: `Answer ${index}.` }],
						api: "anthropic-messages",
						provider: "anthropic",
						model: "claude-sonnet-4-5",
						usage: {
							input: 0,
							output: 0,
							cacheRead: 0,
							cacheWrite: 0,
							totalTokens: 0,
							cost: {
								input: 0,
								output: 0,
								cacheRead: 0,
								cacheWrite: 0,
								total: 0,
							},
						},
						stopReason: "stop",
					},
		);
	}
	return entries;
}

function contextFor(entries: readonly SessionEntry[]): {
	event: { messages: unknown[] };
	ctx: ExtensionContext;
} {
	const byId = new Map(entries.map((entry) => [entry.id, entry]));
	const leafId = entries.at(-1)?.id ?? null;
	// Pi 0.87 runner.js emitContext clones the projection and filters out
	// system messages before calling `context` handlers.
	const messages = structuredClone(
		buildSessionContext(entries as SessionEntry[], leafId, byId).messages,
	).filter((message) => (message as { role?: unknown }).role !== "system");
	const ctx = {
		cwd: "/tmp/append-pass-work-bound",
		hasUI: false,
		signal: new AbortController().signal,
		ui: { notify: () => undefined },
		model: {
			provider: "anthropic",
			id: "claude-sonnet-4-5",
			contextWindow: 400_000,
		},
		sessionManager: {
			getSessionId: () => SESSION_ID,
			getLeafId: () => leafId,
			getBranch: () => [...entries],
			getEntry: (id: string) => byId.get(id),
		},
		getContextUsage: () => ({
			tokens: 1_000,
			percent: 0.25,
			contextWindow: 400_000,
		}),
	} as unknown as ExtensionContext;
	return { event: { messages }, ctx };
}

async function appendPassFingerprints(messageCount: number): Promise<number> {
	const db = createTestDb();
	// A fallback row left by an in-flight message that changed before Pi
	// persisted it. Its fingerprint matches no live message.
	db.prepare(
		`INSERT INTO tags (session_id, message_id, type, byte_size, reasoning_byte_size,
		   tag_number, harness, entry_fingerprint, status)
		 VALUES (?, 'pi-msg-0-1-user:p0', 'message', 10, 0, 1, 'pi', ?, 'compacted')`,
	).run(SESSION_ID, JSON.stringify([null, 1, "user", null, "0".repeat(64)]));
	const handlers = new Map<string, (...args: unknown[]) => unknown>();
	registerPiContextHandler(
		{
			on(event: string, handler: (...args: unknown[]) => unknown) {
				handlers.set(event, handler);
			},
		} as never,
		{
			db: db as never,
			protectedTags: 20,
			scheduler: { executeThresholdPercentage: 95 },
			heuristics: { caveman: { enabled: false, minChars: 2_000 } },
			injection: {
				memoryEnabled: false,
				injectDocs: false,
				injectionBudgetTokens: 4_000,
				temporalAwareness: false,
			},
		},
	);
	const handler = handlers.get("context");
	if (!handler) throw new Error("context handler was not registered");
	const entries = buildEntries(messageCount + 2);
	try {
		// Warm the session in chunks that each fit the pass budget, ending with
		// a pass at `messageCount` so the measured pass appends exactly two.
		for (const point of [2_500, 5_000, 7_500, messageCount]) {
			if (point > messageCount) continue;
			const { event, ctx } = contextFor(entries.slice(0, point + 1));
			await handler(event, ctx);
		}
		const { event, ctx } = contextFor(entries);
		const before = __test.readPiEntryFingerprintCount();
		await handler(event, ctx);
		const transformError = db
			.prepare(
				"SELECT last_transform_error AS error FROM session_meta WHERE session_id = ?",
			)
			.get(SESSION_ID) as { error?: string } | null;
		expect(transformError?.error ?? "").toBe("");
		return __test.readPiEntryFingerprintCount() - before;
	} finally {
		clearContextHandlerSession(SESSION_ID);
		db.close();
	}
}

describe("Pi append-pass work bound", () => {
	afterEach(() => clearContextHandlerSession(SESSION_ID));

	it("hashes the same number of messages on an append pass at 1k and 10k messages", async () => {
		const small = await appendPassFingerprints(1_000);
		const large = await appendPassFingerprints(10_000);
		// Two new branch entries enter the cached lookup and two new messages
		// need fingerprints for tag creation; nothing scales with history.
		expect(small).toBeLessThanOrEqual(8);
		expect(large).toBe(small);
	}, 180_000);
});

describe("Pi fallback fingerprint header filter", () => {
	it("keeps every reusable message whose fingerprint a fallback row could carry", () => {
		const entries = buildEntries(40);
		const { event } = contextFor(entries);
		const messages = event.messages as Parameters<
			typeof __test.buildEntryFingerprintMap
		>[0];
		const resolve = (_message: unknown, index: number) => `entry-${index}`;
		const reusable = new Set(
			Array.from({ length: 38 }, (_, index) => `entry-${index}`),
		);
		const full = __test.buildEntryFingerprintMap(messages, resolve);
		const lingering = full.get("entry-7");
		if (!lingering) throw new Error("fixture message has no fingerprint");
		const headers = new Set([
			JSON.stringify(JSON.parse(lingering).slice(0, 4)),
		]);
		const filtered = __test.buildEntryFingerprintMap(
			messages,
			resolve,
			reusable,
			true,
			headers,
		);
		// The matching reusable message and the two new messages, with the exact
		// fingerprints an unfiltered build produces.
		expect([...filtered.keys()]).toEqual(["entry-7", "entry-38", "entry-39"]);
		for (const [id, fingerprint] of filtered)
			expect(fingerprint).toBe(full.get(id) as string);
	});
});
