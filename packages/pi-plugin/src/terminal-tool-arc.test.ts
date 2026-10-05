import { createTagger } from "@magic-context/core/features/magic-context/tagger";
import { registerTerminalToolArcTests } from "@magic-context/core/hooks/magic-context/terminal-tool-arc-test-support.test";
import { tagTranscript } from "@magic-context/core/shared/tag-transcript";
import { applyPiHeuristicCleanup } from "./heuristic-cleanup-pi";
import { createPiTranscript } from "./transcript-pi";

registerTerminalToolArcTests("pi", {
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
				protectedTags: 0,
				protectedCutoff: null,
				routine: false,
				staleReduceStripEnabled: false,
				emergency: {
					currentTotalInputTokens: percentage * 2000,
					ceilingTokens: 200000 * 0.65,
					usagePercentage: percentage,
				},
			},
		);
		transcript.commit();
		transcript.finalizeToolRemovals();
		return result.emergencyDroppedTools;
	},
	// Pi sends toolResult messages as user-role tool results; an assistant at the
	// end of the array is sent as an assistant-terminated request.
	terminalShape(fixture) {
		const last = fixture.pi.at(-1);
		if (!last) return { wireTailRole: "none", wireTailCallId: null };
		if (last.role === "toolResult") {
			return { wireTailRole: "user", wireTailCallId: String(last.toolCallId) };
		}
		return { wireTailRole: String(last.role), wireTailCallId: null };
	},
});
