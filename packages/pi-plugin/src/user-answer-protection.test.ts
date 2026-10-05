import { expect, it } from "bun:test";
import { createTagger } from "@magic-context/core/features/magic-context/tagger";
import { buildSyntheticToolReclaimOps } from "@magic-context/core/hooks/magic-context/tool-reclaim";
import { tagTranscript } from "@magic-context/core/shared/tag-transcript";
import {
	assistantToolCall,
	createTestDb,
	toolResultMessage,
} from "./test-utils.test";
import { createPiTranscript } from "./transcript-pi";

it("Pi and OMP answer details exclude automatic age reclaim but permit explicit drops", () => {
	for (const details of [
		{ question: "choose", options: ["keep"], answer: "keep", wasCustom: false },
		{
			questions: [{ id: "q" }],
			answers: [{ id: "q", value: "keep", label: "keep", wasCustom: false }],
			cancelled: false,
		},
		{ question: "choose", selectedOptions: ["keep"], multi: false },
		{ results: [{ id: "q", question: "choose", selectedOptions: ["keep"] }] },
	]) {
		const db = createTestDb();
		try {
			const session = "pi-answers";
			const messages = [
				assistantToolCall("answered", "renamed-question"),
				{ ...toolResultMessage("answered", "answer ".repeat(1000)), details },
				assistantToolCall("ordinary", "bash"),
				toolResultMessage("ordinary", "output ".repeat(1000)),
			];
			const transcript = createPiTranscript(messages, session);
			const tagger = createTagger();
			tagger.initFromDb(session, db);
			const { targets } = tagTranscript(session, transcript, tagger, db);
			const answerTarget = [...targets.entries()].find(
				([, target]) => target.canDrop?.() === false,
			);
			expect(answerTarget).toBeDefined();
			const ops = buildSyntheticToolReclaimOps({
				db,
				sessionId: session,
				targets,
				watermark: 100,
			});
			expect(ops.some((op) => op.tagId === answerTarget?.[0])).toBe(false);
			expect(ops.length).toBeGreaterThan(0);
			expect(answerTarget?.[1].drop()).toBe("removed");
		} finally {
			db.close();
		}
	}
});

it("Pi emergency keeps the largest tier-3 answer and reaches its limit with other results", async () => {
	const { applyPiHeuristicCleanup } = await import("./heuristic-cleanup-pi");
	const { getTagsBySession } = await import(
		"@magic-context/core/features/magic-context/storage"
	);
	const db = createTestDb();
	try {
		const session = "pi-emergency-answer";
		const messages = [
			assistantToolCall("answered", "ask"),
			{
				...toolResultMessage("answered", "answer ".repeat(8000)),
				details: { selectedOptions: ["keep"] },
			},
		];
		for (let n = 1; n <= 29; n++)
			messages.push(
				assistantToolCall(`ordinary-${n}`, "bash"),
				toolResultMessage(`ordinary-${n}`, "noise ".repeat(2000)),
			);
		const transcript = createPiTranscript(messages, session);
		const tagger = createTagger();
		tagger.initFromDb(session, db);
		const { targets } = tagTranscript(session, transcript, tagger, db);
		const answerTag = [...targets.keys()][0];
		expect(answerTag).toBeDefined();
		const cleanup = applyPiHeuristicCleanup(session, db, targets, messages, {
			protectedTags: 0,
			protectedCutoff: null,
			staleReduceStripEnabled: false,
			emergency: { currentTotalInputTokens: 66000, ceilingTokens: 50000 },
		});
		expect(
			getTagsBySession(db, session).find((tag) => tag.tagNumber === answerTag)
				?.status,
		).toBe("active");
		expect(cleanup.emergencyDroppedTools).toBeGreaterThan(0);
		const retained = getTagsBySession(db, session)
			.filter((tag) => tag.status === "active")
			.reduce((sum, tag) => sum + (tag.tokenCount ?? 0), 0);
		expect(retained).toBeLessThan(50000);
	} finally {
		db.close();
	}
});
