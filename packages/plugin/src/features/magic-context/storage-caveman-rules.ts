import { isRecord } from "../../shared/record-type-guard";
import type { Database } from "../../shared/sqlite";
import {
    ReplayDocumentError,
    readReplayEnvelope,
    updateReplayDocument,
} from "./storage-replay-document";

/**
 * Which caveman rule set a session's compressed text tags are served with,
 * stored as its own namespace in the per-session replay document, so no schema
 * change is needed.
 *
 * Replay recomputes compressed text from the original on every pass, so the
 * rule set has to be persisted. A session that has never recorded one was
 * compressed by the original rules and keeps replaying them, byte for byte,
 * until caveman cleanup runs on a pass that already rebuilds the provider
 * cache. That pass records the current rules and rewrites every compressed tag
 * with them, and every later pass replays the current rules.
 *
 * `englishWordRules` records whether the current rules run their English word
 * lists, which the user-level `language` setting decides. A changed setting
 * takes effect the same way: on the next cleanup pass, which records it and
 * rewrites every compressed tag. Absent means English, the only choice before
 * the setting existed.
 *
 * `legacyReasoningTags` lists the tags compressed before the switch to the
 * current rules. The original rules also took the reasoning of each compressed
 * message off the wire; those messages keep that, since putting the reasoning
 * back would change bytes the provider already cached. Tags compressed after
 * the switch keep their reasoning.
 */
const NAMESPACE = "caveman";
const CURRENT_RULES_VERSION = 2;

export interface CavemanReplayState {
    currentRules: boolean;
    englishWordRules: boolean;
    legacyReasoningTags: ReadonlySet<number>;
}

const ORIGINAL_RULES: CavemanReplayState = {
    currentRules: false,
    englishWordRules: true,
    legacyReasoningTags: new Set(),
};

function parseState(lane: unknown): CavemanReplayState {
    if (!isRecord(lane) || lane.rules !== CURRENT_RULES_VERSION) return ORIGINAL_RULES;
    const tags = Array.isArray(lane.legacyReasoningTags) ? lane.legacyReasoningTags : [];
    return {
        currentRules: true,
        englishWordRules: lane.englishWordRules !== false,
        legacyReasoningTags: new Set(
            tags.filter((tag): tag is number => Number.isSafeInteger(tag) && tag > 0),
        ),
    };
}

/**
 * The session's caveman replay state. A document that cannot be read answers
 * with the original rules, which is what the session served before it recorded
 * anything.
 */
export function getCavemanReplayState(db: Database, sessionId: string): CavemanReplayState {
    try {
        return parseState(readReplayEnvelope(db, sessionId)[NAMESPACE]);
    } catch (error) {
        if (error instanceof ReplayDocumentError) return ORIGINAL_RULES;
        throw error;
    }
}

/**
 * Record that the session's compressed text now uses the current rules with
 * the given word rules. `legacyReasoningTags` is written only by the switch
 * from the original rules; a session already on the current rules keeps the
 * list it recorded then. Returns the persisted state, or null when the
 * document could not be written; the caller must then keep the state it read.
 */
export function recordCavemanCurrentRules(
    db: Database,
    sessionId: string,
    englishWordRules: boolean,
    legacyReasoningTags: Iterable<number>,
): CavemanReplayState | null {
    const tags = [...new Set(legacyReasoningTags)].sort((a, b) => a - b);
    const persisted = updateReplayDocument(db, sessionId, (doc) => {
        const current = parseState(doc[NAMESPACE]);
        if (current.currentRules && current.englishWordRules === englishWordRules) return false;
        doc.version = 2;
        doc[NAMESPACE] = {
            rules: CURRENT_RULES_VERSION,
            legacyReasoningTags: current.currentRules
                ? [...current.legacyReasoningTags].sort((a, b) => a - b)
                : tags,
            ...(englishWordRules ? {} : { englishWordRules: false }),
        };
        return true;
    });
    if (!persisted) return null;
    const state = getCavemanReplayState(db, sessionId);
    return state.currentRules && state.englishWordRules === englishWordRules ? state : null;
}
