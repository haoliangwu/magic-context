import { describe, expect, it, mock } from "bun:test";
import { appendCompartments } from "@magic-context/core/features/magic-context/compartment-storage";
import {
	getPendingOps,
	getPendingPiCompactionMarkerState,
	getTagsBySession,
	queuePendingOp,
	setPendingPiCompactionMarkerState,
} from "@magic-context/core/features/magic-context/storage";
import { closeQuietly } from "@magic-context/core/shared/sqlite-helpers";
import {
	clearContextHandlerSession,
	registerPiContextHandler,
	signalPiDeferredHistoryRefresh,
	signalPiDeferredMaterialization,
} from "./context-handler";
import {
	assistantMessage,
	createFakePi,
	createTestDb,
	fakeContext,
	textOf,
	userMessage,
} from "./test-utils.test";

type PassMessages = ReturnType<typeof userMessage>[];
type ContextHandler = (
	event: { messages: never[] },
	ctx: never,
) => Promise<{ messages: never[] } | undefined>;

/**
 * One execute-threshold crossing must cost exactly one provider cache bust, and
 * the defer pass after it must replay the reclaim request's bytes. The reclaim
 * pass here does everything at once, as in a real session: deferred
 * publication refreshes the history head (m[0]/m[1]), queued drops apply, and
 * the pending native compaction marker drains into Pi's journal. A split where
 * the reclaim request goes out with the old head and the next defer pass serves
 * the refreshed one would bust the cache twice for one crossing.
 */
describe("Pi execute-threshold reclaim costs one bust", () => {
	it("serves the refreshed head with the trim, and the next defer pass replays it", async () => {
		const db = createTestDb();
		const sessionId = "ses-pi-reclaim-single-bust";
		const fake = createFakePi();
		registerPiContextHandler(fake.pi as never, {
			db,
			heuristics: {},
			injection: { injectionBudgetTokens: 10_000 },
			protectedTags: 1,
		});
		const handler = fake.handlers.get("context") as ContextHandler;
		const branch: Array<Record<string, unknown>> = [];
		const appendCompaction = mock(
			(_summary: unknown, firstKeptEntryId: unknown) => {
				branch.push({
					type: "compaction",
					id: "compact-reclaim",
					firstKeptEntryId,
				});
				return "compact-reclaim";
			},
		);
		const runPass = async (
			messages: PassMessages,
			usagePercent: number,
		): Promise<{ messages: never[] }> => {
			const ctx = fakeContext(
				sessionId,
				process.cwd(),
				messages.map((_message, index) => `entry-${index}`),
				messages as never,
			) as unknown as {
				sessionManager: {
					getBranch: () => unknown[];
					appendCompaction?: typeof appendCompaction;
				};
				getContextUsage: () => unknown;
			};
			// Pi keeps one journal per session: message entries for this pass,
			// followed by any compaction entry an earlier pass appended.
			const messageEntries = ctx.sessionManager.getBranch();
			ctx.sessionManager.getBranch = () => [...messageEntries, ...branch];
			ctx.sessionManager.appendCompaction = appendCompaction;
			ctx.getContextUsage = () => ({
				tokens: usagePercent * 1_000,
				percent: usagePercent,
				contextWindow: 100_000,
			});
			const result = await handler(
				{ messages: messages as never[] },
				ctx as never,
			);
			return result ?? { messages: messages as never[] };
		};

		try {
			// Pi builds a fresh AgentMessage[] for every context event, and the
			// handler edits that array in place, so each pass gets new objects.
			const transcript = (turns: number): PassMessages =>
				[
					userMessage("covered request", 1),
					assistantMessage("covered answer", 2),
					userMessage("keep steering", 3),
					assistantMessage("steering acknowledged", 4),
					userMessage("next question", 5),
					assistantMessage("next answer", 6),
				].slice(0, turns * 2);
			await runPass(transcript(1), 0);

			// The historian published a compartment while the session was
			// deferring, and queued a drop and a native compaction marker. All
			// three wait for the next execute-threshold pass.
			const reclaimTag = getTagsBySession(db, sessionId).find(
				(tag) => tag.status === "active",
			);
			expect(reclaimTag).toBeDefined();
			queuePendingOp(db, sessionId, reclaimTag?.id ?? -1, "drop");
			appendCompartments(db, sessionId, [
				{
					sequence: 0,
					startMessage: 1,
					endMessage: 2,
					startMessageId: "entry-0",
					endMessageId: "entry-1",
					title: "Published while deferring",
					content: "U: covered request\nA: covered answer",
					p1: "U: covered request\nA: covered answer",
				},
			]);
			setPendingPiCompactionMarkerState(db, sessionId, {
				firstKeptEntryId: "entry-2",
				endMessageId: "entry-1",
				ordinal: 2,
				tokensBefore: 10,
				summary: "summary",
				publishedAt: 1,
			});
			signalPiDeferredHistoryRefresh(sessionId);
			signalPiDeferredMaterialization(sessionId);

			const reclaim = await runPass(transcript(2), 75);
			const reclaimServed = structuredClone(reclaim.messages);

			// The next turn is far below the execute threshold, so it defers.
			const deferred = await runPass(transcript(3), 40);

			// Byte-identical prefix: everything the reclaim request served is
			// served again unchanged, and only the new turn is appended. A head
			// that changes between these two requests is a second bust.
			expect(
				JSON.stringify(deferred.messages.slice(0, reclaimServed.length)),
			).toBe(JSON.stringify(reclaimServed));
			expect(deferred.messages.length).toBeGreaterThan(reclaimServed.length);

			// The reclaim pass did all of its queued work in its own request; the
			// defer pass found nothing left to apply or append.
			expect(getPendingOps(db, sessionId)).toHaveLength(0);
			expect(appendCompaction).toHaveBeenCalledTimes(1);
			expect(getPendingPiCompactionMarkerState(db, sessionId)).toBeNull();

			// A reclaim changes the prompt in two places: it refreshes the history
			// head and trims the turn that history now covers. The single bust must
			// carry both, or a second bust would follow to land the missing one.
			const reclaimText = reclaimServed
				.map((message) => textOf(message as never))
				.join("\n");
			expect(reclaimText).toContain("Published while deferring");
			const reclaimTail = reclaimServed
				.slice(2)
				.map((message) => textOf(message as never));
			expect(reclaimTail).not.toContainEqual(
				expect.stringContaining("covered request"),
			);
			expect(reclaimTail).toEqual([
				expect.stringContaining("keep steering"),
				expect.stringContaining("steering acknowledged"),
			]);
		} finally {
			clearContextHandlerSession(sessionId);
			closeQuietly(db);
		}
	});
});
