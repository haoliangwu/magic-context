import { createTagger } from "../../features/magic-context/tagger";
import { applyHeuristicCleanup } from "./heuristic-cleanup";
import { tagMessages } from "./tag-messages";
import { registerTerminalToolArcTests } from "./terminal-tool-arc-test-support.test";

registerTerminalToolArcTests("opencode", {
    cleanup(db, sessionId, fixture, percentage) {
        const tagger = createTagger();
        tagger.initFromDb(sessionId, db);
        const tagged = tagMessages(sessionId, fixture.opencode, tagger, db);
        const result = applyHeuristicCleanup(
            sessionId,
            db,
            tagged.targets,
            tagged.messageTagNumbers,
            {
                protectedTagNumbers: new Set(),
                // Subagent sessions reach the emergency band without a protected window.
                protectedCutoff: null,
                routine: false,
                emergency: {
                    currentTotalInputTokens: percentage * 2000,
                    ceilingTokens: 200000 * 0.65,
                    usagePercentage: percentage,
                },
            },
        );
        tagged.batch.finalize();
        return result.emergencyDroppedTools;
    },
    // OpenCode serializes an assistant's completed tool parts as a trailing tool
    // result, so the request is user-terminated only while the last message still
    // carries one.
    terminalShape(fixture) {
        const last = fixture.opencode.at(-1);
        if (!last) return { wireTailRole: "none", wireTailCallId: null };
        if (last.info.role !== "assistant")
            return { wireTailRole: last.info.role, wireTailCallId: null };
        const tools = last.parts.filter(
            (part) =>
                (part as { type?: string }).type === "tool" &&
                ["completed", "error"].includes(
                    String((part as { state?: { status?: string } }).state?.status),
                ),
        ) as Array<{ callID: string }>;
        const tail = tools.at(-1);
        return tail
            ? { wireTailRole: "user", wireTailCallId: tail.callID }
            : { wireTailRole: "assistant", wireTailCallId: null };
    },
});
