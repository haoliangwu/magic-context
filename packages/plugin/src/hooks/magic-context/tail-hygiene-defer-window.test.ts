import { describe, expect, it } from "bun:test";
import type { TagEntry } from "../../features/magic-context/types";
import {
    buildChannel1Reminder,
    type Channel1Level,
    type Channel1VerdictReason,
    decideChannel1,
} from "./ctx-reduce-nudge";
import type { MessageLike } from "./tag-messages";
import {
    formatTailHygienePrefixMismatch,
    refreshTailHygieneBaseline,
    type TailHygieneBaseline,
} from "./tail-hygiene-walk";

/**
 * A long defer window is the normal OpenCode shape since routine execute passes
 * stopped busting the prefix: one full walk, then many passes that only append a
 * tool arc. These tests drive that sequence through the real baseline instrument
 * and the real Channel-1 decision, so a prefix mismatch mid-window is measured
 * the way a live session measures it.
 */

const PROSE_TOKENS_PER_MESSAGE = "prose text ".repeat(13_000);
const TOOL_OUTPUT_BODY = "tool output row ".repeat(4_400);

function toolArc(ordinal: number, body: string): MessageLike {
    return {
        info: { id: `assistant-arc-${ordinal}`, role: "assistant" },
        parts: [
            {
                type: "tool",
                callID: `call-arc-${ordinal}`,
                tool: "read",
                state: { input: { path: `file-${ordinal}.ts` }, output: body },
            },
        ],
    };
}

function toolTag(ordinal: number): TagEntry {
    return {
        tagNumber: ordinal,
        messageId: `call-arc-${ordinal}`,
        type: "tool",
        status: "active",
        dropMode: "full",
        toolName: "read",
        inputByteSize: 0,
        byteSize: 1,
        reasoningByteSize: 0,
        sessionId: "ses-defer-window",
        cavemanDepth: 0,
        toolOwnerMessageId: `assistant-arc-${ordinal}`,
    };
}

/** m0 head, a real prompt, one historical assistant narration, then tool arcs. */
function sessionHead(): MessageLike[] {
    return [
        {
            info: { id: "m0-head", role: "user" },
            parts: [{ type: "text", text: "magic context head ".repeat(200), synthetic: true }],
        },
        {
            info: { id: "user-prompt", role: "user" },
            parts: [{ type: "text", text: PROSE_TOKENS_PER_MESSAGE }],
        },
        {
            info: { id: "assistant-narration", role: "assistant" },
            parts: [{ type: "text", text: `${PROSE_TOKENS_PER_MESSAGE}\n\n` }],
        },
    ];
}

interface PassRecord {
    pass: number;
    fired: boolean;
    level: Channel1Level;
    band: string;
    reason: Channel1VerdictReason;
    generation: number;
    mismatchLine: string | null;
}

/**
 * Drive one bust pass plus `deferPasses` defer passes. Each defer pass appends a
 * tool arc; `mutateHistoryOnPass` rewrites an already-frozen historical part, the
 * class of change that a defer pass cannot attribute to an append.
 */
function driveDeferWindow(input: {
    deferPasses: number;
    mutateHistoryOnPass: number;
    releaseProtectionFromPass: number;
}): PassRecord[] {
    const messages = sessionHead();
    const tags: TagEntry[] = [];
    let arcs = 0;
    const appendArc = (): void => {
        arcs += 1;
        messages.push(toolArc(arcs, `${TOOL_OUTPUT_BODY}${arcs}`));
        tags.push(toolTag(arcs));
    };
    appendArc();
    appendArc();

    const records: PassRecord[] = [];
    let baseline: TailHygieneBaseline | undefined;
    // Durable Channel-1 cadence state, the same two fields hook-handlers persists.
    let lastNudgeUndropped = 0;
    let lastNudgeLevel: Channel1Level | "" = "";

    for (let pass = 1; pass <= input.deferPasses + 1; pass += 1) {
        if (pass > 1) appendArc();
        if (pass === input.mutateHistoryOnPass) {
            // A historical assistant part loses its trailing blank line after it
            // was already measured into the frozen prefix.
            const narration = messages[2].parts[0] as { text: string };
            narration.text = narration.text.replace(/\n\n$/, "");
        }
        // Before the release pass the whole tool tail sits inside the protection
        // window; afterwards only the newest arc does.
        const protectedTagNumbers =
            pass < input.releaseProtectionFromPass
                ? new Set(tags.map((tag) => tag.tagNumber))
                : new Set([arcs]);
        baseline = refreshTailHygieneBaseline({
            messages,
            tags,
            protectedTagNumbers,
            cacheBusting: pass === 1,
            previous: baseline,
        });
        const decision = decideChannel1({
            ...baseline,
            lastNudgeUndropped,
            lastNudgeLevel,
            hasRecentReduce: false,
        });
        lastNudgeUndropped = decision.nextLastNudge;
        lastNudgeLevel = decision.nextLastNudgeLevel;
        if (decision.fire) {
            // What tool.execute.after does: the reminder lands on the newest tool
            // output and is replayed with it from then on.
            const newestArc = messages[messages.length - 1].parts[0] as {
                state: { output: string };
            };
            newestArc.state.output += buildChannel1Reminder(
                decision.level,
                decision.undroppedTokens,
                4,
            );
        }
        records.push({
            pass,
            fired: decision.fire,
            level: decision.level,
            band: decision.band,
            reason: decision.verdictReason,
            generation: baseline.baselineGeneration,
            mismatchLine: baseline.lastPrefixMismatch
                ? formatTailHygienePrefixMismatch(
                      baseline.lastPrefixMismatch,
                      baseline.baselineGeneration,
                  )
                : null,
        });
    }
    return records;
}

describe("channel 1 across a long defer window", () => {
    it("fires after a mid-window prefix mismatch instead of holding to the next bust", () => {
        const records = driveDeferWindow({
            deferPasses: 10,
            mutateHistoryOnPass: 3,
            releaseProtectionFromPass: 3,
        });
        const firstFire = records.find((record) => record.fired);
        const afterMismatch = records.filter((record) => record.pass >= 3);

        // Quiet before the protection boundary releases the tool tail.
        expect(records.slice(0, 2).every((record) => !record.fired)).toBe(true);
        expect(records.slice(0, 2).map((record) => record.band)).toEqual(["quiet", "quiet"]);
        // The fleet shape: 10 defer passes, one mismatch, and a fire well inside them.
        expect(records).toHaveLength(11);
        expect(firstFire?.pass).toBeGreaterThanOrEqual(3);
        expect(firstFire?.pass).toBeLessThanOrEqual(5);
        expect(afterMismatch.map((record) => record.reason)).not.toContain("baseline-unevaluable");
        expect(
            afterMismatch.filter((record) => record.reason === "baseline-unevaluable"),
        ).toHaveLength(0);
    });

    it("names the first mismatching part exactly once per invalidation event", () => {
        const records = driveDeferWindow({
            deferPasses: 10,
            mutateHistoryOnPass: 3,
            releaseProtectionFromPass: 3,
        });
        const diagnosed = records.filter((record) => record.mismatchLine !== null);

        // Reminders fired on earlier passes ride along in the tool outputs that
        // later passes freeze; a replayed reminder must not read as a mismatch.
        expect(diagnosed).toHaveLength(1);
        expect(diagnosed[0].pass).toBe(3);
        expect(diagnosed[0].mismatchLine).toContain("message=assistant-narration");
        expect(diagnosed[0].mismatchLine).toContain("field=contentHash");
        expect(diagnosed[0].mismatchLine).toMatch(/part_index=\d+/);
        expect(diagnosed[0].mismatchLine).toContain("action=re-measured");
    });

    it("reports the shape that actually moved, one cause per invalidation", () => {
        const head = sessionHead();
        const arcs = [toolArc(1, TOOL_OUTPUT_BODY), toolArc(2, `${TOOL_OUTPUT_BODY}2`)];
        const tags = [toolTag(1), toolTag(2)];
        const frozen = refreshTailHygieneBaseline({
            messages: [...head, ...arcs],
            tags,
            protectedTagNumbers: new Set(),
            cacheBusting: true,
        });

        // A compaction-marker window advance folds historical messages away, so the
        // measured array no longer reaches the end of the frozen prefix.
        const shorter = refreshTailHygieneBaseline({
            messages: [head[0], arcs[1]],
            tags,
            protectedTagNumbers: new Set(),
            cacheBusting: false,
            previous: frozen,
        });
        // A tag status flip outside a bust changes what a frozen part contributes.
        const flipped = refreshTailHygieneBaseline({
            messages: [...head, ...arcs],
            tags: [{ ...tags[0], status: "dropped" as const }, tags[1]],
            protectedTagNumbers: new Set(),
            cacheBusting: false,
            previous: frozen,
        });
        // Protection reaching backwards over an already-frozen part is not an append.
        const protectedAgain = refreshTailHygieneBaseline({
            messages: [...head, ...arcs],
            tags,
            protectedTagNumbers: new Set([1]),
            cacheBusting: false,
            previous: frozen,
        });

        expect(shorter.lastPrefixMismatch?.field).toBe("shorter");
        expect(shorter.lastPrefixMismatch?.messageId).toBe("assistant-arc-1");
        expect(flipped.lastPrefixMismatch?.field).toBe("tagStatus");
        expect(flipped.lastPrefixMismatch?.messageId).toBe("assistant-arc-1");
        expect(protectedAgain.lastPrefixMismatch?.field).toBe("protection-entered");
        // Each of the three recovered in its own pass instead of holding.
        for (const baseline of [shorter, flipped, protectedAgain]) {
            expect(baseline.evaluable).toBe(true);
            expect(baseline.generationInvalidated).toBe(false);
            expect(baseline.baselineGeneration).toBe(frozen.baselineGeneration + 1);
        }
    });

    it("advances the baseline generation once per re-measure and keeps counting appends", () => {
        const records = driveDeferWindow({
            deferPasses: 10,
            mutateHistoryOnPass: 3,
            releaseProtectionFromPass: 3,
        });
        const generations = records.map((record) => record.generation);

        // One bust generation, one re-measure generation, and nothing else.
        expect(new Set(generations).size).toBe(2);
        expect(generations[0]).toBe(generations[1]);
        expect(generations[2]).toBe(generations[0] + 1);
        expect(generations[10]).toBe(generations[2]);
    });
});
