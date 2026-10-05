import { setEmergencyDropSample } from "@magic-context/core/features/magic-context/storage-meta-persisted";
import { createTagger } from "@magic-context/core/features/magic-context/tagger";
import { registerIssue423Tests } from "@magic-context/core/hooks/magic-context/issue-423-test-support.test";
import { tagTranscript } from "@magic-context/core/shared/tag-transcript";
import { applyPiHeuristicCleanup } from "./heuristic-cleanup-pi";
import { convertEntriesToRawMessages } from "./read-session-pi";
import { createPiTranscript } from "./transcript-pi";

registerIssue423Tests("pi", {
	raw: (fixture) => convertEntriesToRawMessages(fixture.entries),
	cleanup(db, sessionId, fixture, percentage) {
		const tagger = createTagger();
		tagger.initFromDb(sessionId, db);
		const transcript = createPiTranscript(fixture.pi, sessionId);
		const tagged = tagTranscript(sessionId, transcript, tagger, db);
		const result = applyPiHeuristicCleanup(
			sessionId,
			db,
			tagged.targets,
			fixture.pi,
			{
				protectedTags: 24,
				routine: false,
				staleReduceStripEnabled: false,
				emergency: {
					currentTotalInputTokens: percentage * 2040,
					ceilingTokens: 204000 * 0.65,
					usagePercentage: percentage,
				},
			},
		);
		transcript.commit();
		// This selector-only adapter owns the caller's finalization step. The real
		// context handler waits for every lane, including native activation.
		if (result.emergencyDroppedTools > 0) {
			setEmergencyDropSample(db, sessionId, percentage * 2040);
		}
		return result.emergencyDroppedTools;
	},
	anthropicMessages: (fixture) =>
		fixture.pi.map((message, index) => {
			const role =
				message.role === "toolResult" ? "user" : String(message.role);
			const source = Array.isArray(message.content)
				? message.content
				: [{ type: "text", text: String(message.content ?? "") }];
			const parts = source.flatMap((part) => {
				if (part === null || typeof part !== "object") return [];
				const block = part as Record<string, unknown>;
				if (message.role === "toolResult") {
					return [
						{
							type: "tool_result",
							tool_use_id: message.toolCallId,
							content: block.text ?? block,
						},
					];
				}
				if (block.type === "toolCall") {
					return [
						{
							type: "tool_use",
							id: block.id,
							name: block.name,
							input: block.arguments,
						},
					];
				}
				return [structuredClone(block)];
			});
			return { info: { id: `wire-${index}`, role }, parts };
		}),
});

import { registerIssue423HistorianTest } from "@magic-context/core/hooks/magic-context/issue-423-test-support.test";
import { runPiHistorian } from "./pi-historian-runner";

registerIssue423HistorianTest(
	"pi",
	async ({ db, sessionId, raw, boundary, xml, holderId }) => {
		await runPiHistorian({
			db,
			sessionId,
			directory: process.cwd(),
			provider: { readMessages: () => raw },
			runner: {
				run: async () => ({ ok: true, assistantText: xml, durationMs: 1 }),
			},
			historianModel: "test/model",
			historianContextLimit: 1_000_000,
			historianChunkTokens: 20000,
			boundarySnapshot: boundary,
			compartmentLeaseHolderId: holderId,
			memoryEnabled: false,
		});
	},
	(fixture) => convertEntriesToRawMessages(fixture.entries),
);
