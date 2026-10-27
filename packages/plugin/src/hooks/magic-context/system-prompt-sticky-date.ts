import {
    readReplayEnvelope,
    updateReplayDocument,
} from "../../features/magic-context/storage-replay-document";
import { sessionLog } from "../../shared/logger";
import type { Database } from "../../shared/sqlite";

/**
 * The host date fields the session's system prompt is frozen to (the sticky
 * date, a JSON array of the dates found in the prompt), kept in the session's
 * replay document so it survives a process restart.
 *
 * The system hook keeps the sticky date in memory and changes it only on a
 * pass that may rebuild the prompt. Without this record a restart after
 * midnight would adopt the new date on its first request, a change in front of
 * every signed thinking block that request keeps. The persisted system-prompt
 * hash was computed with the frozen date, so a caller restores this value only
 * when it reproduces that hash.
 */
const STICKY_DATE_KEY = "systemPromptStickyDate";

/** The persisted sticky date, or undefined when none is recorded or it cannot be read. */
export function readPersistedSystemPromptStickyDate(
    db: Database,
    sessionId: string,
): string | undefined {
    try {
        const saved = readReplayEnvelope(db, sessionId, "read")[STICKY_DATE_KEY];
        return typeof saved === "string" && saved.length > 0 ? saved : undefined;
    } catch (error) {
        sessionLog(sessionId, "system prompt sticky date record unreadable:", error);
        return undefined;
    }
}

/**
 * Record the sticky date; false when it could not be written. Best effort: a
 * failed write only loses the date across a restart, which then behaves as it
 * did before the record existed.
 */
export function persistSystemPromptStickyDate(
    db: Database,
    sessionId: string,
    stickyDate: string,
): boolean {
    try {
        const written = updateReplayDocument(db, sessionId, (doc) => {
            if (doc[STICKY_DATE_KEY] === stickyDate) return false;
            doc.version = 2;
            doc[STICKY_DATE_KEY] = stickyDate;
            return true;
        });
        if (!written) sessionLog(sessionId, "system prompt sticky date record not written");
        return written;
    } catch (error) {
        sessionLog(sessionId, "system prompt sticky date record write failed:", error);
        return false;
    }
}
