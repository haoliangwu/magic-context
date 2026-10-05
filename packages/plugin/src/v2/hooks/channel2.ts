import { randomBytes } from "node:crypto";
import type { ContextDatabase } from "../../features/magic-context/storage";
import {
    casChannel2NudgeClaim,
    claimChannel2NudgeState,
    getChannel2NudgeState,
} from "../../features/magic-context/storage-meta-persisted";
import {
    buildChannel2Reminder,
    type Channel1State,
    evaluateChannel2,
    reclaimableToolOutputCount,
} from "../../hooks/magic-context/ctx-reduce-nudge";
import type { V2Context } from "./types";

// These are candidates, not admission decisions. Storage still authenticates every
// candidate. Remember sends that have not reached the host's SQL projection yet.
const pendingCandidates = new WeakMap<V2Context["storage"], Map<string, string>>();

export function syntheticCandidates(
    context: Pick<V2Context, "storage">,
    sessionID: string,
    stored: Set<string>,
): Set<string> {
    const pending = pendingCandidates.get(context.storage);
    for (const [key, id] of pending ?? []) {
        if (!key.startsWith(`${sessionID}/`)) continue;
        if (stored.has(id)) pending?.delete(key);
        else stored.add(id);
    }
    return stored;
}

export function clearSyntheticCandidates(context: Pick<V2Context, "storage">): void {
    pendingCandidates.delete(context.storage);
}

/** Record the admitted identity before sending; recognition never relies on its prefix. */
export async function deliverSynthetic(
    context: Pick<V2Context, "session" | "storage">,
    sessionID: string,
    text: string,
): Promise<string> {
    const id = `msg_${randomBytes(12).toString("hex")}`;
    await context.storage.set(`synthetic/${sessionID}/${id}`, { id });
    let candidates = pendingCandidates.get(context.storage);
    if (!candidates) {
        candidates = new Map();
        pendingCandidates.set(context.storage, candidates);
    }
    candidates.set(`${sessionID}/${id}`, id);
    await context.session.synthetic({ sessionID, id, text, delivery: "steer" });
    return id;
}

export async function isAdmittedSynthetic(
    context: Pick<V2Context, "storage">,
    sessionID: string,
    id: string,
): Promise<boolean> {
    const record = await context.storage.get(`synthetic/${sessionID}/${id}`);
    return record !== null && typeof record === "object" && "id" in record && record.id === id;
}

export async function deliverPendingChannel2(
    context: V2Context,
    db: ContextDatabase,
    sessionID: string,
    baseline: Channel1State | undefined,
): Promise<void> {
    if (getChannel2NudgeState(db, sessionID) !== "pending") return;
    const evaluation = evaluateChannel2(baseline);
    if (!evaluation.evaluable || !evaluation.shouldTrigger) return;
    const token = randomBytes(16).toString("hex");
    if (!claimChannel2NudgeState(db, sessionID, token)) return;
    try {
        await deliverSynthetic(
            context,
            sessionID,
            buildChannel2Reminder(
                evaluation.reclaimableTokens,
                reclaimableToolOutputCount(baseline?.baselineParts ?? []),
            ),
        );
    } catch (error) {
        casChannel2NudgeClaim(db, sessionID, "pending", token);
        throw error;
    }
    casChannel2NudgeClaim(db, sessionID, "delivered", token);
}
