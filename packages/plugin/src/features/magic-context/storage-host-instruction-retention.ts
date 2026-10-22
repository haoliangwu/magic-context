import type { Database } from "../../shared/sqlite";
import { readReplayEnvelope, updateReplayDocument } from "./storage-replay-document";

/**
 * Whether this session serves OpenCode 2 instruction rows that its history
 * summary already covers.
 *
 * OpenCode 2 stores instruction updates (the daily date line, a changed
 * AGENTS.md) as `system` rows and sends them without a message id. A history
 * summary is not proof that such an instruction survived, so every trim keeps
 * them. Sessions served before that rule cut a covered instruction row on most
 * passes; turning the rule on changes what they serve, so the switch is only
 * set on a pass that may rewrite the whole served prefix, and every later pass
 * reads it. Stored as its own namespace in the per-session replay document, so
 * no schema change is needed.
 */
const NAMESPACE = "hostInstructionRetention";

let enabled = true;

/** False only in tests that reproduce the serving of releases before this switch existed. */
export function hostInstructionRetentionEnabled(): boolean {
    return enabled;
}

export function setHostInstructionRetentionEnabledForTests(value: boolean): void {
    enabled = value;
}

export function isHostInstructionRetentionOn(db: Database, sessionId: string): boolean {
    const lane = readReplayEnvelope(db, sessionId)[NAMESPACE];
    return typeof lane === "object" && lane !== null && (lane as { on?: unknown }).on === true;
}

/**
 * Persist the switch. True when it is persisted, whether this call wrote it or
 * it was already set; false when the document could not be written.
 */
export function markHostInstructionRetention(db: Database, sessionId: string): boolean {
    return updateReplayDocument(db, sessionId, (doc) => {
        const lane = doc[NAMESPACE];
        if (typeof lane === "object" && lane !== null && (lane as { on?: unknown }).on === true)
            return false;
        doc.version = 2;
        doc[NAMESPACE] = { on: true };
        return true;
    });
}
