import { describe, expect, test } from "bun:test";
import { getTagsBySession } from "../../features/magic-context/storage";
import { initializeDatabase } from "../../features/magic-context/storage-db";
import { Database } from "../../shared/sqlite";
import { closeQuietly } from "../../shared/sqlite-helpers";
import type { MessageLike } from "./tag-messages";

/**
 * A subagent tool loop in the absolute emergency band (>=95%): one prompt, then
 * completed rounds whose assistant turn carries a short text beside its tool
 * call and no reasoning. With no reasoning the emergency drop is allowed to
 * remove whole arcs, and the newest arc's result is what ends the request with
 * a user turn. Anthropic models without prefill support reject a request whose
 * last message is an assistant, which is what removing that arc produced.
 */
export function terminalToolArcFixture(rounds = 8) {
    const output = "file line of filler text\n".repeat(2000);
    const opencode: MessageLike[] = [
        {
            info: { id: "m0", role: "user" },
            parts: [{ type: "text", text: "Read the files one by one." }],
        },
    ];
    const pi: Array<Record<string, unknown>> = [
        { role: "user", content: "Read the files one by one.", timestamp: 1 },
    ];
    for (let round = 1; round <= rounds; round += 1) {
        const callID = `call-${round}`;
        const input = { command: `cat f${round}.txt`, description: "read file" };
        opencode.push({
            info: { id: `m${round}`, role: "assistant" },
            parts: [
                { type: "step-start" },
                { type: "text", text: `Reading batch ${round}.` },
                {
                    type: "tool",
                    tool: "bash",
                    callID,
                    state: { status: "completed", input, output, title: "", metadata: {} },
                },
                { type: "step-finish", reason: "tool-calls" },
            ],
        });
        pi.push({
            role: "assistant",
            content: [
                { type: "text", text: `Reading batch ${round}.` },
                { type: "toolCall", id: callID, name: "bash", arguments: input },
            ],
            stopReason: "toolUse",
            timestamp: pi.length + 1,
        });
        pi.push({
            role: "toolResult",
            toolCallId: callID,
            toolName: "bash",
            content: [{ type: "text", text: output }],
            timestamp: pi.length + 1,
        });
    }
    return { opencode, pi };
}

export type TerminalToolArcFixture = ReturnType<typeof terminalToolArcFixture>;

/** What the provider serializer sees at the end of the served array, per lane. */
export interface TerminalShape {
    /** Role the provider request ends with once tool results are serialized. */
    wireTailRole: string;
    /** Call id whose result ends the request, when it ends with one. */
    wireTailCallId: string | null;
}

export function registerTerminalToolArcTests(
    harness: "opencode" | "pi",
    adapter: {
        cleanup: (
            db: Database,
            sessionId: string,
            fixture: TerminalToolArcFixture,
            percentage: number,
        ) => number;
        terminalShape: (fixture: TerminalToolArcFixture) => TerminalShape;
    },
) {
    describe(`${harness} emergency drop keeps the request user-terminated`, () => {
        for (const percentage of [95, 100]) {
            test(`at ${percentage}% the newest completed arc survives as a skeleton`, () => {
                const db = new Database(":memory:");
                initializeDatabase(db);
                const sessionId = `terminal-arc-${harness}-${percentage}`;
                try {
                    const fixture = terminalToolArcFixture();
                    expect(adapter.cleanup(db, sessionId, fixture, percentage)).toBeGreaterThan(0);

                    const shape = adapter.terminalShape(fixture);
                    expect(shape.wireTailRole).toBe("user");
                    expect(shape.wireTailCallId).toBe("call-8");

                    // The newest arc was still eligible and may be reduced, but only
                    // to a skeleton, and its persisted mode must replay the same way.
                    const newest = getTagsBySession(db, sessionId).find(
                        (tag) => tag.type === "tool" && tag.messageId.includes("call-8"),
                    );
                    if (newest?.status === "dropped") expect(newest.dropMode).toBe("skeleton_real");
                } finally {
                    closeQuietly(db);
                }
            });
        }
    });
}
