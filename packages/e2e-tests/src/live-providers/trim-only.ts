import type { CallRecord, TrimOnlyEvidence } from "./types";

interface HistoryMessage {
    role: string;
    signed: string[];
    nonThinking: Array<{ type: string; hash: string }>;
}

function history(call: CallRecord): HistoryMessage[] {
    return (call.request.flags.history ?? []) as HistoryMessage[];
}
const signed = (call: CallRecord) => history(call).flatMap((m) => m.signed);
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** A 200 alone is not a qualification: prove the actual edit and inspect server diagnostics. */
export function qualifyTrimOnly(calls: CallRecord[]): TrimOnlyEvidence {
    const failures: string[] = [];
    const before = [...calls].reverse().find((c) => c.phase === "turn-1" && c.accepted);
    const trim = calls.find((c) => c.phase === "trim-only");
    const cache = calls.find((c) => c.phase === "cache-follow-up");
    const edit = calls.find((c) => c.phase === "tool-edit");
    let removedOldestBlocks = 0;
    let retainedSignedBlocks = 0;
    if (!before || !trim || !cache || !edit) {
        failures.push("not reached: seed, trim-only, cache follow-up and tool-edit calls are required");
    } else {
        const old = signed(before);
        const kept = signed(trim).filter((hash) => old.includes(hash));
        retainedSignedBlocks = kept.length;
        removedOldestBlocks = old.length - kept.length;
        if (old.length < 2 || kept.length === 0 || removedOldestBlocks <= 0 || !same(kept, old.slice(removedOldestBlocks))) {
            failures.push("trim did not remove only a nonempty gap-free oldest prefix while retaining newer signed blocks");
        }
        const beforeHistory = history(before);
        const trimHistory = history(trim);
        if (beforeHistory.some((m, i) => !same(m.nonThinking, trimHistory[i]?.nonThinking) || m.role !== trimHistory[i]?.role) ||
            before.request.flags.systemHash !== trim.request.flags.systemHash || before.request.flags.toolsHash !== trim.request.flags.toolsHash) {
            failures.push("trim pass also changed earlier non-thinking content, system or tools");
        }
        if (signed(cache).some((hash) => old.slice(0, removedOldestBlocks).includes(hash))) failures.push("cache follow-up restored removed thinking");
        const cacheHistory = history(cache);
        if (trimHistory.some((m, i) => !same(m, cacheHistory[i])) ||
            trim.request.flags.systemHash !== cache.request.flags.systemHash || trim.request.flags.toolsHash !== cache.request.flags.toolsHash) {
            failures.push("cache follow-up changed the trimmed prefix instead of replaying it identically");
        }
        if ((cache.usage?.cachedRead ?? 0) <= 0) failures.push("next request did not report a cache read");
        else if ((cache.usage?.cachedRead ?? 0) <= (trim.usage?.cachedRead ?? 0)) failures.push("next request did not recover cache reads beyond the trimming point");
        const editHistory = history(edit);
        const toolIndex = cacheHistory.findIndex((m) => m.nonThinking.some((b) => b.type === "tool_result"));
        if (toolIndex < 0 || same(cacheHistory[toolIndex]?.nonThinking, editHistory[toolIndex]?.nonThinking)) {
            failures.push("mixed pass did not edit an earlier tool result");
        }
        if (toolIndex >= 0 && editHistory.slice(toolIndex).some((m) => m.signed.length > 0)) {
            failures.push("mixed pass retained signed thinking after the earlier tool-result edit");
        }
        for (const call of [trim, cache, edit]) {
            if (!call.accepted || call.status !== 200 || !call.usage) failures.push(`call ${call.index} was not accepted with usage`);
            if (Object.keys(call.diagnostics).length) failures.push(`call ${call.index} returned transformation diagnostics; inspect before qualifying`);
        }
        if (trim.request.flags.bindingBeta !== true ||
            (trim.request.flags.thinking as { block_binding?: { prefix_mismatch_behavior?: string } })?.block_binding?.prefix_mismatch_behavior !== "error") {
            failures.push("trim request did not force strict prefix binding with its beta");
        }
    }
    return { qualified: failures.length === 0, failures, removedOldestBlocks, retainedSignedBlocks,
        trimCall: trim?.index ?? null, cacheCall: cache?.index ?? null, toolEditCall: edit?.index ?? null };
}
