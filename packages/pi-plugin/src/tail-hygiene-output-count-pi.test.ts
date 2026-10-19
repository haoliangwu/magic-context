import { expect, test } from "bun:test";
import {
	captureChannel1PostReduceGraceBaseline,
	getChannel1NudgeState,
	getTagsBySession,
	insertTag,
	setChannel1NudgeState,
	setChannel2NudgeState,
	setLastNudgeUndropped,
} from "@magic-context/core/features/magic-context/storage";
import { currentReclaimableToolOutputCount } from "@magic-context/core/hooks/magic-context/tail-hygiene-output-count";
import {
	clearPiChannel1State,
	getPiChannel1Baseline,
	markPiChannel1Reduced,
	maybeChannel1ReminderForToolResult,
	maybeDeliverChannel2Pi,
	setPiChannel1Baseline,
} from "./ctx-reduce-nudge-pi";
import { refreshPiTailHygieneBaseline } from "./tail-hygiene-walk-pi";
import { createTestDb } from "./test-utils.test";

test("Pi first delivery counts current outputs and sticky replay keeps its original bytes", () => {
	const db = createTestDb();
	const sessionId = "pi-current-count-replay";
	const thinking = {
		type: "thinking",
		thinking: "reason",
		thinkingSignature: "signature",
		metadata: { diagnostics: "original UI" },
	};
	const messages: unknown[] = Array.from({ length: 20 }, () => ({
		role: "user",
		content: "earlier prompt",
	}));
	const addOutput = (id: string, words: number, tagNumber: number) => {
		const owner = `entry-${messages.length}`;
		messages.push(
			{
				role: "assistant",
				content: [
					...(tagNumber === 1 ? [thinking] : []),
					{ type: "toolCall", id, name: "edit", arguments: {} },
				],
				api: "openai-completions",
				provider: "openai",
				model: "fixture",
				stopReason: "toolUse",
			},
			{
				role: "toolResult",
				toolCallId: id,
				toolName: "edit",
				content: [{ type: "text", text: "data ".repeat(words) }],
				isError: false,
			},
		);
		insertTag(
			db,
			sessionId,
			id,
			"tool",
			words * 5,
			tagNumber,
			0,
			"edit",
			2,
			owner,
		);
	};
	const serve = () => {
		const baseline = refreshPiTailHygieneBaseline({
			messages,
			tags: getTagsBySession(db, sessionId),
			protectedTagNumbers: new Set(),
			protectedTools: {},
			stableId: (_message, index) => `entry-${index}`,
			previous: getPiChannel1Baseline(sessionId),
			cacheBusting: !getPiChannel1Baseline(sessionId),
		});
		const grace = captureChannel1PostReduceGraceBaseline(
			db,
			sessionId,
			baseline.baselineU + baseline.turnDeltaU,
		);
		setPiChannel1Baseline(sessionId, {
			...baseline,
			usableWindow: 1_000_000,
			reducedSinceRefresh: false,
			agentDropsAppliedThisPass: false,
			oldestReclaimableToolTags: [],
			channel1PostReduceGrace:
				grace.postReduceGracePending ||
				grace.postReduceGraceBaselineU !== undefined
					? {
							pending: grace.postReduceGracePending === true,
							baselineU: grace.postReduceGraceBaselineU,
							preReduceLevel: grace.postReduceGracePreLevel ?? grace.level,
						}
					: undefined,
		});
	};
	try {
		addOutput("old", 80_000, 1);
		messages.push({ role: "user", content: "continue" });
		serve();
		const initial = getPiChannel1Baseline(sessionId);
		if (!initial) throw new Error("missing initial baseline");
		setLastNudgeUndropped(
			db,
			sessionId,
			initial.baselineU + initial.turnDeltaU,
		);
		setChannel1NudgeState(db, sessionId, { level: "urgent", ordinal: 1 });
		markPiChannel1Reduced(sessionId, db);
		serve();
		addOutput("new", 40_000, 2);
		messages.push({ role: "user", content: "continue after append" });
		serve();
		const state = getPiChannel1Baseline(sessionId);
		if (!state) throw new Error("missing appended baseline");
		expect(currentReclaimableToolOutputCount(state)).toBe(2);
		const original = [{ type: "text", text: "synthetic next result" }];
		const first = maybeChannel1ReminderForToolResult({
			db,
			sessionId,
			toolName: "bash",
			content: original,
		});
		expect(first?.text).toContain("Still unstamped: 2 spent tool outputs");
		if (!first) throw new Error("missing first delivery");
		const delivered = [...original, first];
		const bytes = JSON.stringify(delivered);
		messages.push({
			role: "toolResult",
			toolCallId: "delivered",
			toolName: "bash",
			content: delivered,
			isError: false,
		});
		thinking.metadata.diagnostics = "different UI after first delivery";
		addOutput("third", 40_000, 3);
		messages.push(
			...Array.from({ length: 5 }, () => ({
				role: "user",
				content: "later prompt",
			})),
		);
		serve();
		expect(
			currentReclaimableToolOutputCount(getPiChannel1Baseline(sessionId)),
		).toBe(3);
		const before = getChannel1NudgeState(db, sessionId);
		const replay = maybeChannel1ReminderForToolResult({
			db,
			sessionId,
			toolName: "bash",
			content: delivered,
		});
		expect(replay).toBeNull();
		expect(JSON.stringify(replay ? [...delivered, replay] : delivered)).toBe(
			bytes,
		);
		expect(getChannel1NudgeState(db, sessionId)).toEqual(before);
		const fresh = maybeChannel1ReminderForToolResult({
			db,
			sessionId,
			toolName: "bash",
			content: original,
		});
		expect(fresh?.text).toContain("3 spent tool outputs");
		const sent: string[] = [];
		const sender = {
			sendMessage: (message: { content: string }) => {
				sent.push(JSON.stringify(message));
			},
		};
		setChannel2NudgeState(db, sessionId, "pending");
		expect(maybeDeliverChannel2Pi(sender, db, sessionId)).toBe(true);
		expect(sent[0]).toContain("3 spent tool outputs");
		const firstCeiling = sent[0];
		thinking.metadata.diagnostics = "UI changes again after ceiling delivery";
		addOutput("fourth", 40_000, 4);
		serve();
		expect(
			currentReclaimableToolOutputCount(getPiChannel1Baseline(sessionId)),
		).toBe(4);
		expect(maybeDeliverChannel2Pi(sender, db, sessionId)).toBe(false);
		expect(sent).toEqual([firstCeiling]);
	} finally {
		clearPiChannel1State(sessionId);
		db.close();
	}
});
