import {
    appendCompartments,
    getCompartments,
} from "../../features/magic-context/compartment-storage";
import { sessionLog } from "../../shared/logger";
import type { Database } from "../../shared/sqlite";
import type { SessionChunk } from "./read-session-chunk";

/** Persist only a positively scanned, contiguous, entirely excluded head; missing rows are not noise. */
export function persistFilteredNoise(
    db: Database,
    sessionId: string,
    chunk: SessionChunk,
    eligibleEnd: number,
): boolean {
    const rows = chunk.filteredNoiseLines ?? [];
    const start = chunk.startIndex;
    if (
        chunk.text ||
        chunk.messageCount !== 0 ||
        eligibleEnd <= start ||
        rows.length !== eligibleEnd - start ||
        rows.some((row, index) => row.ordinal !== start + index || !row.messageId)
    )
        return false;
    const saved = db
        .transaction(() => {
            const prior = getCompartments(db, sessionId);
            const last = prior.at(-1);
            if ((last?.endMessage ?? 0) + 1 !== start) return false;
            appendCompartments(db, sessionId, [
                {
                    sequence: (last?.sequence ?? -1) + 1,
                    startMessage: start,
                    endMessage: eligibleEnd - 1,
                    startMessageId: rows[0].messageId,
                    endMessageId: rows[rows.length - 1].messageId,
                    title: "",
                    content: "",
                    p1: "",
                    p2: "",
                    p3: "",
                    p4: "",
                    episodeType: "filtered-noise",
                    importance: 1,
                },
            ]);
            return true;
        })
        .immediate();
    if (saved)
        sessionLog(
            sessionId,
            `historian skipped ordinals ${start}-${eligibleEnd - 1}: all ${rows.length} raw rows excluded by chunk filters (no-content boundary marker)`,
        );
    return saved;
}
