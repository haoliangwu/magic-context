import { afterEach, describe, expect, it, setSystemTime } from "bun:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { buildSessionContext } from "pi-coding-agent-087";
import {
	__test,
	clearContextHandlerSession,
	registerPiContextHandler,
} from "./context-handler";
import { createFakePi, createTestDb } from "./test-utils.test";

// Pi entry-id resolution: the visible-only positional lane with per-position
// header checks, and the header filter on fallback-tag adoption. Each case is
// followed by a partner: the closest neighbouring case, so a reader can see the
// boundary. Each case below pins the raw-entry shape and the served projection.

type Entry = Record<string, unknown> & {
	id: string;
	parentId: string | null;
	type: string;
	timestamp: string;
};

const START = 1_800_000_000_000;

/** A hand-built Pi 0.87 session tree with deterministic ids and timestamps. */
class Session {
	readonly byId = new Map<string, Entry>();
	leafId: string | null = null;
	clock = START;
	private next = 0;

	private add(row: Record<string, unknown>): string {
		const id = `e${this.next++}`;
		this.byId.set(id, {
			...row,
			id,
			parentId: this.leafId,
			timestamp: new Date(this.clock).toISOString(),
		} as Entry);
		this.leafId = id;
		return id;
	}

	message(message: Record<string, unknown>, advance = true): string {
		if (advance) this.clock += 1_000;
		return this.add({
			type: "message",
			message: { timestamp: this.clock, ...message },
		});
	}

	/** What Pi 0.87.1 appends when it omits a failed attempt before a retry. */
	omit(targetId: string): string {
		this.clock += 1_000;
		return this.add({ type: "context_edit", targetId, replacement: null });
	}

	branch(): Entry[] {
		const path: Entry[] = [];
		for (let id = this.leafId; id; ) {
			const entry = this.byId.get(id);
			if (!entry) break;
			path.push(entry);
			id = entry.parentId;
		}
		return path.reverse();
	}

	/** The array Pi 0.87 hands `context` handlers: a clone without systems. */
	event(): unknown[] {
		return structuredClone(
			buildSessionContext(
				this.branch() as never,
				this.leafId,
				this.byId as never,
			).messages as unknown[],
		).filter((message) => (message as { role?: unknown }).role !== "system");
	}

	ctx(sessionId: string): ExtensionContext {
		return {
			cwd: "/nonexistent/pi-entry-alignment-review",
			hasUI: false,
			signal: new AbortController().signal,
			ui: { notify: () => undefined },
			model: { provider: "anthropic", id: "claude-sonnet-4-5" },
			sessionManager: {
				getSessionId: () => sessionId,
				getLeafId: () => this.leafId,
				getEntry: (id: string) => this.byId.get(id),
				getBranch: () => this.branch(),
			},
			getContextUsage: () => ({
				tokens: 10_000,
				percent: 5,
				contextWindow: 200_000,
			}),
		} as unknown as ExtensionContext;
	}
}

function assistant(text: string, responseId: string, extra = {}) {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		responseId,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		...extra,
	};
}

/** Leading `§N§` tag number of each served message (null when untagged). */
function servedTags(messages: unknown[]): (number | null)[] {
	return messages.map((message) => {
		const match = /^"?§(\d+)§/.exec(
			JSON.stringify((message as { content?: unknown }).content).replace(
				/^\[\{"type":"text","text":/,
				"",
			),
		);
		return match ? Number(match[1]) : null;
	});
}

/**
 * Serves three passes of the same session: the second carries one extra
 * message that another extension appended (so its length no longer matches
 * the projection), the first and third do not. Returns the `§N§` tags of the
 * two watched user messages on each pass.
 */
async function tagsAcrossExtraMessagePass(
	sessionId: string,
	identicalPair: boolean,
): Promise<number[][]> {
	const db = createTestDb();
	const fake = createFakePi();
	registerPiContextHandler(fake.pi as never, {
		db,
		protectedTags: 0,
		injection: { injectionBudgetTokens: 10_000 },
	});
	const handler = fake.handlers.get("context") as (
		event: { messages: unknown[] },
		ctx: unknown,
	) => Promise<{ messages: unknown[] } | undefined>;
	const s = new Session();
	setSystemTime(new Date(START));
	try {
		s.message({ role: "system", content: "You are a coding agent." }, false);
		s.message({ role: "user", content: "Read the config loader." });
		s.message(assistant("It parses JSONC.", "r0"));
		// The pair whose tags are watched. Identical text stamped in one
		// millisecond gives both the same content fingerprint.
		s.message({ role: "user", content: "continue" });
		s.message(
			{ role: "user", content: identicalPair ? "continue" : "and then?" },
			false,
		);
		s.message(assistant("Continuing.", "r1"));
		// Event positions of the pair (after the first user/assistant exchange).
		const watched = [2, 3];
		const result: number[][] = [];
		for (const extra of [false, true, false]) {
			s.clock += 10;
			setSystemTime(new Date(s.clock));
			const messages = s.event();
			if (extra) {
				messages.push({
					role: "custom",
					customType: "reminder",
					content: [{ type: "text", text: "Remember the style guide." }],
					display: false,
					timestamp: s.clock,
				});
			}
			// The handler edits the event array in place, so read its length first.
			const sent = messages.length;
			const served = await handler({ messages }, s.ctx(sessionId));
			const out = served?.messages ?? messages;
			const tags = servedTags(out);
			// Magic Context prepends its synthetic history messages; every event
			// message keeps its order behind them, and the extra message is last.
			const offset = out.length - sent;
			result.push(watched.map((index) => tags[index + offset] ?? -1));
		}
		return result;
	} finally {
		clearContextHandlerSession(sessionId);
		db.close();
		setSystemTime();
	}
}

describe("Pi entry alignment review: lane alternation", () => {
	afterEach(() => setSystemTime());

	// Two messages whose content fingerprints collide can only be identified
	// by position. A pass whose length differs from the projection (here, one
	// extra message another extension appended) cannot use the positional lane;
	// it used to match every message by fingerprint, leave the pair unresolved
	// and tag it under index-based `pi-msg-*` ids, serving different `§N§` tags
	// on each lane switch (3,4 then 6,7 then 3,4). The header-anchored lane now
	// keeps their real ids. The distinct-pair partner below checks that
	// messages with unique fingerprints keep their tags across the same passes.
	it("keeps the served tags of two identical same-millisecond messages when another extension appends a message on one pass", async () => {
		const tags = await tagsAcrossExtraMessagePass(
			"alignment-review-identical-pair",
			true,
		);
		expect(tags[1]).toEqual(tags[0]);
		expect(tags[2]).toEqual(tags[0]);
	}, 30_000);

	it("keeps the served tags of two distinct messages when another extension appends a message on one pass", async () => {
		const tags = await tagsAcrossExtraMessagePass(
			"alignment-review-distinct-pair",
			false,
		);
		expect(tags[0]?.every((tag) => tag > 0)).toBe(true);
		expect(tags[1]).toEqual(tags[0]);
		expect(tags[2]).toEqual(tags[0]);
	}, 30_000);
});

/** A session whose last assistant attempt failed and was retried. */
function sessionWithOmittedAttempt(omit: boolean): {
	s: Session;
	visibleIds: string[];
} {
	const s = new Session();
	s.message({ role: "system", content: "You are a coding agent." }, false);
	const ids = [
		s.message({ role: "user", content: "Read the config loader." }),
		s.message(assistant("It parses JSONC.", "r0")),
		s.message({ role: "user", content: "Now the tests." }),
	];
	const failed = s.message(
		assistant("", "r1", { stopReason: "error", errorMessage: "overloaded" }),
	);
	if (omit) s.omit(failed);
	else ids.push(failed);
	ids.push(s.message(assistant("They pass.", "r2")));
	ids.push(s.message({ role: "user", content: "Thanks." }));
	return { s, visibleIds: ids };
}

function resolveTwice(sessionId: string, s: Session) {
	const entries = s.branch();
	const ctx = s.ctx(sessionId);
	const resolve = () =>
		__test.resolvePiEventEntryIds(
			ctx,
			s.event() as Parameters<typeof __test.resolvePiEventEntryIds>[1],
			sessionId,
			entries,
		);
	resolve();
	const before = __test.readPiEntryFingerprintCount();
	const ids = resolve();
	return {
		ids: [...(ids ?? [])],
		hashed: __test.readPiEntryFingerprintCount() - before,
	};
}

describe("Pi entry alignment review: context_edit omissions", () => {
	// Pi 0.87.1 appends a `context_edit` entry with a null
	// replacement to drop a failed attempt from the model context before every
	// automatic retry (agent-session.js _omitRecoveryAttempt). The visible
	// projection applies those entries; before it did, its length exceeded the
	// event by one for as long as the omitted entry was in the retained range,
	// and every such pass hashed every message on the fingerprint lane.
	it("uses the positional lane after Pi omits a failed attempt with a context_edit entry", () => {
		const { s, visibleIds } = sessionWithOmittedAttempt(true);
		try {
			const { ids, hashed } = resolveTwice("alignment-review-omitted", s);
			expect(ids).toEqual(visibleIds);
			expect(hashed).toBe(0);
		} finally {
			clearContextHandlerSession("alignment-review-omitted");
		}
	});

	it("uses the positional lane when the failed attempt was not omitted", () => {
		const { s, visibleIds } = sessionWithOmittedAttempt(false);
		try {
			const { ids, hashed } = resolveTwice("alignment-review-kept", s);
			expect(ids).toEqual(visibleIds);
			expect(hashed).toBe(0);
		} finally {
			clearContextHandlerSession("alignment-review-kept");
		}
	});

	// Ids stay correct when the omitted session is also resolved off the
	// positional lane: here one extra message from another extension makes the
	// event longer than the projection.
	it("still resolves every id off the positional lane after the omission", () => {
		const { s, visibleIds } = sessionWithOmittedAttempt(true);
		try {
			const messages = s.event();
			messages.push({
				role: "custom",
				customType: "reminder",
				content: [{ type: "text", text: "Remember the style guide." }],
				display: false,
				timestamp: s.clock + 1,
			});
			const ids = resolveOnce("alignment-review-omitted-ids", s, messages);
			expect(ids).toEqual([...visibleIds, undefined]);
		} finally {
			clearContextHandlerSession("alignment-review-omitted-ids");
		}
	});
});

function resolveOnce(sessionId: string, s: Session, messages: unknown[]) {
	return [
		...(__test.resolvePiEventEntryIds(
			s.ctx(sessionId),
			messages as Parameters<typeof __test.resolvePiEventEntryIds>[1],
			sessionId,
			s.branch(),
		) ?? []),
	];
}

describe("Pi entry alignment review: positional checks that hold", () => {
	it("keeps the positional lane when the host adds late fields such as completedAt and contextSnapshot", () => {
		const s = new Session();
		s.message({ role: "system", content: "You are a coding agent." }, false);
		const ids = [
			s.message({ role: "user", content: "Read the config loader." }),
			s.message(assistant("It parses JSONC.", "r0")),
		];
		const messages = s.event();
		for (const message of messages) {
			Object.assign(message as object, {
				completedAt: s.clock + 5,
				contextSnapshot: { tokens: 123 },
			});
		}
		try {
			expect(resolveOnce("alignment-review-late-fields", s, messages)).toEqual(
				ids,
			);
		} finally {
			clearContextHandlerSession("alignment-review-late-fields");
		}
	});

	// By design the header is the identity where it is unique: a message an
	// earlier extension rewrites in place keeps the id of the entry it replaced.
	it("gives a message rewritten in place with its header unchanged the id of the entry it replaced", () => {
		const s = new Session();
		const ids = [
			s.message({ role: "user", content: "Read the config loader." }),
			s.message(assistant("It parses JSONC.", "r0")),
		];
		const messages = s.event();
		(messages[0] as { content: unknown }).content =
			"Redacted by another extension.";
		try {
			expect(resolveOnce("alignment-review-rewrite", s, messages)).toEqual(ids);
		} finally {
			clearContextHandlerSession("alignment-review-rewrite");
		}
	});

	it("checks content when messages without timestamps share a header, and resolves a swap by content", () => {
		const s = new Session();
		const first = s.message({ role: "user", content: "First." });
		const second = s.message({ role: "user", content: "Second." });
		for (const id of [first, second]) {
			delete (s.byId.get(id)?.message as { timestamp?: unknown }).timestamp;
		}
		try {
			expect(resolveOnce("alignment-review-no-ts", s, s.event())).toEqual([
				first,
				second,
			]);
			const swapped = s.event().reverse();
			expect(resolveOnce("alignment-review-no-ts", s, swapped)).toEqual([
				second,
				first,
			]);
		} finally {
			clearContextHandlerSession("alignment-review-no-ts");
		}
	});

	it("leaves two swapped custom messages from one millisecond unresolved instead of trading their ids", () => {
		const s = new Session();
		s.message({ role: "user", content: "Start." });
		s.clock += 1_000;
		for (const text of ["Reminder A.", "Reminder B."]) {
			const id = `custom-${text.at(-2)}`;
			s.byId.set(id, {
				type: "custom_message",
				id,
				parentId: s.leafId,
				timestamp: new Date(s.clock).toISOString(),
				customType: "reminder",
				content: [{ type: "text", text }],
				display: false,
			} as Entry);
			s.leafId = id;
		}
		const messages = s.event();
		[messages[1], messages[2]] = [messages[2], messages[1]];
		try {
			const ids = resolveOnce("alignment-review-custom-swap", s, messages);
			expect(ids[1]).not.toBe("custom-A");
			expect(ids[2]).not.toBe("custom-B");
		} finally {
			clearContextHandlerSession("alignment-review-custom-swap");
		}
	});

	it("realigns after /tree navigation and keeps appending on the new branch without hashing", () => {
		const sessionId = "alignment-review-tree";
		const s = new Session();
		s.message({ role: "system", content: "You are a coding agent." }, false);
		const u0 = s.message({ role: "user", content: "Read the config loader." });
		const a0 = s.message(assistant("It parses JSONC.", "r0"));
		s.message({ role: "user", content: "Try a refactor." });
		s.message(assistant("Refactored.", "r1"));
		const ctx = s.ctx(sessionId);
		const readAndResolve = () => {
			const entries = __test.readPiBranchEntriesForContext(ctx, sessionId);
			const before = __test.readPiEntryFingerprintCount();
			const ids = __test.resolvePiEventEntryIds(
				ctx,
				s.event() as Parameters<typeof __test.resolvePiEventEntryIds>[1],
				sessionId,
				entries,
			);
			return {
				ids: [...(ids ?? [])],
				hashed: __test.readPiEntryFingerprintCount() - before,
			};
		};
		try {
			readAndResolve();
			// Navigate back to a0 with a branch summary, then continue there.
			s.clock += 1_000;
			s.leafId = a0;
			const summary = `summary-${a0}`;
			s.byId.set(summary, {
				type: "branch_summary",
				id: summary,
				parentId: a0,
				timestamp: new Date(s.clock).toISOString(),
				fromId: "e4",
				summary: "Tried a refactor and abandoned it.",
			} as Entry);
			s.leafId = summary;
			const u1 = s.message({ role: "user", content: "Different approach." });
			expect(readAndResolve()).toEqual({
				ids: [u0, a0, summary, u1],
				hashed: 0,
			});
			const a1 = s.message(assistant("Done.", "r2"));
			expect(readAndResolve()).toEqual({
				ids: [u0, a0, summary, u1, a1],
				hashed: 0,
			});
		} finally {
			clearContextHandlerSession(sessionId);
		}
	});
});

describe("Pi entry alignment review: fallback header filter", () => {
	// The filter skips hashing an already-tagged message unless a persisted
	// `pi-msg-*` fingerprint shares its header. Adoption only acts on exact
	// fingerprint matches, and equal fingerprints have equal headers, so the
	// adoptable set must be the same with and without the filter. The rows
	// below include an exact match, a header match whose content differs, and
	// a row whose header no longer matches any message.
	it("finds the same adoptable fingerprints with and without the header filter", () => {
		const s = new Session();
		s.message({ role: "user", content: "Read the config loader." });
		s.message(assistant("It parses JSONC.", "r0"));
		s.message({ role: "user", content: "Now the tests." });
		s.message(assistant("They pass.", "r1"));
		const messages = s.event() as Parameters<
			typeof __test.buildEntryFingerprintMap
		>[0];
		const resolve = (_message: unknown, index: number) => `entry-${index}`;
		const full = __test.buildEntryFingerprintMap(messages, resolve);
		const exact = full.get("entry-1") as string;
		const parsed = JSON.parse(full.get("entry-2") as string) as unknown[];
		const sameHeaderOtherContent = JSON.stringify([
			...parsed.slice(0, 4),
			"f".repeat(64),
		]);
		const staleHeader = JSON.stringify([
			"r9",
			1,
			"assistant",
			null,
			"e".repeat(64),
		]);
		const stored = new Set([exact, sameHeaderOtherContent, staleHeader]);
		const headers = new Set(
			[...stored].map((fp) => JSON.stringify(JSON.parse(fp).slice(0, 4))),
		);
		const reusable = new Set(["entry-0", "entry-1", "entry-2", "entry-3"]);
		const filtered = __test.buildEntryFingerprintMap(
			messages,
			resolve,
			reusable,
			true,
			headers,
		);
		const adoptable = (map: ReadonlyMap<string, string>) =>
			[...map].filter(([, fp]) => stored.has(fp)).map(([id]) => id);
		expect(adoptable(filtered)).toEqual(adoptable(full));
		expect(adoptable(full)).toEqual(["entry-1"]);
		// entry-2 shares a stored header, so it is still hashed (and rejected
		// by content); entry-0 and entry-3 share none and are skipped.
		expect([...filtered.keys()]).toEqual(["entry-1", "entry-2"]);
	});
});
