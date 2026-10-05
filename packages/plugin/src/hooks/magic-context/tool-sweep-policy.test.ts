import { expect, test } from "bun:test";
import { stripReasoningFromMergedAssistants } from "./strip-content";
import type { MessageLike } from "./tag-messages";
import { ToolMutationBatch } from "./tool-drop-target";
import {
    classifyToolSweepCandidates,
    RESERVED_LEDGER_CONTROL_ENTRIES,
    TOOL_SWEEP_SCOPED_MARKER,
} from "./tool-sweep-policy";

test("legacy merged-reasoning reader ignores the scoped-sweep control entry", () => {
    expect(TOOL_SWEEP_SCOPED_MARKER).toBe("@tool-sweep-scoped");
    const messages: MessageLike[] = [
        { info: { id: "first", role: "assistant" }, parts: [{ type: "text", text: "first" }] },
        {
            info: { id: "second", role: "assistant" },
            parts: [{ type: "reasoning", text: "signed thinking" }],
        },
    ];
    const before = structuredClone(messages);
    // The unchanged reader treats unknown entries as message IDs. A reserved
    // control entry must not match any real assistant or select its reasoning.
    expect(
        stripReasoningFromMergedAssistants(messages, "anthropic", {
            frozenMessageIds: new Set([TOOL_SWEEP_SCOPED_MARKER]),
        }),
    ).toBe(0);
    expect(messages).toEqual(before);
});

test("scoped batch removes its empty owner but leaves unrelated reasoning and blank shells", () => {
    const tool = { type: "tool", callID: "call", state: { status: "completed", output: "spent" } };
    const owner: MessageLike = { info: { id: "owner", role: "assistant" }, parts: [tool] };
    const thinking: MessageLike = {
        info: { id: "thinking", role: "assistant" },
        parts: [{ type: "reasoning", text: "signed thinking" }],
    };
    const blank: MessageLike = {
        info: { id: "blank", role: "assistant" },
        parts: [{ type: "text", text: "" }],
    };
    const messages = [owner, thinking, blank];
    const batch = new ToolMutationBatch(messages, true);
    batch.markForRemoval({ message: owner, part: tool, kind: "result" });
    batch.finalize();
    expect(messages).toEqual([thinking, blank]);
});

test("pre-adoption sweep variant follows the array this session was last served", () => {
    const row = (id: string): MessageLike => ({
        info: { id, role: "assistant" },
        parts: [{ type: "text", text: id }],
    });
    // Rows with nothing left to send never reach the provider: one whose parts
    // were spliced away, and one reduced to an empty text shell.
    const emptied = (id: string): MessageLike => ({ info: { id, role: "assistant" }, parts: [] });
    const shell = (id: string): MessageLike => ({
        info: { id, role: "assistant" },
        parts: [{ type: "text", text: "" }],
    });
    // The two sweeps disagree about one unrelated row: "unrelated".
    const candidates = {
        legacy: [row("first"), row("owner-survivor")],
        scoped: [row("first"), row("unrelated"), row("owner-survivor")],
    };
    const lastServedUnderLegacy = [row("first"), row("owner-survivor")];
    const lastServedUnderScoped = [row("first"), row("unrelated"), row("owner-survivor")];

    const absent = classifyToolSweepCandidates(null, candidates);
    expect(absent.condition).toBe("lkg_absent");
    expect(absent.scoped).toBe(true);

    const old = classifyToolSweepCandidates(lastServedUnderLegacy, candidates);
    const scoped = classifyToolSweepCandidates(lastServedUnderScoped, candidates);
    expect(old.condition).toBe("matched_old");
    expect(old.scoped).toBe(false);
    expect(scoped.condition).toBe("matched_scoped");
    expect(scoped.scoped).toBe(true);
    expect(old.condition).not.toBe(scoped.condition);
    expect(old.scoped).not.toBe(scoped.scoped);

    const neither = classifyToolSweepCandidates([row("first"), row("since-removed")], candidates);
    expect(neither.condition).toBe("matched_neither");
    expect(neither.scoped).toBe(false);

    // An emptied row in the recorded array is not a served row, so it neither
    // matches nor blocks the variant that reproduces the rest.
    expect(
        classifyToolSweepCandidates(
            [
                row("first"),
                emptied("dropped-owner"),
                shell("emptied-owner"),
                row("unrelated"),
                row("owner-survivor"),
            ],
            candidates,
        ).condition,
    ).toBe("matched_scoped");

    // Indistinguishable candidates are no reason to change what is served.
    expect(
        classifyToolSweepCandidates(lastServedUnderLegacy, {
            legacy: candidates.legacy,
            scoped: candidates.legacy,
        }).condition,
    ).toBe("matched_old");
    console.log(
        `SCOPED_GATE lkg conditions old=${old.condition} scoped=${scoped.condition} absent=${absent.condition} neither=${neither.condition}`,
    );
});

test("the scoped-sweep marker is a reserved ledger control entry", () => {
    expect(RESERVED_LEDGER_CONTROL_ENTRIES).toContain(TOOL_SWEEP_SCOPED_MARKER);
});

test("scoped gate mixed owner retains surviving text while full owner is spliced", () => {
    const tool = () => ({
        type: "tool",
        callID: "call",
        state: { status: "completed", output: "spent" },
    });
    const full: MessageLike = { info: { id: "full", role: "assistant" }, parts: [tool()] };
    const mixed: MessageLike = {
        info: { id: "mixed", role: "assistant" },
        parts: [tool(), { type: "text", text: "survivor" }],
    };
    const messages = [full, mixed];
    const batch = new ToolMutationBatch(messages, true);
    for (const message of messages)
        batch.markForRemoval({ message, part: message.parts[0], kind: "result" });
    batch.finalize();
    expect(messages).toEqual([mixed]);
    expect(mixed.parts).toEqual([{ type: "text", text: "survivor" }]);
    console.log("SCOPED_GATE full owner spliced; mixed owner survives");
});
