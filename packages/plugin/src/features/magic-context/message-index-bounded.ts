import { createHash } from "node:crypto";
import type { RawMessage } from "../../hooks/magic-context/read-session-raw";
import {
    type Database,
    withIndexChunk,
    withSqliteBackgroundWriter,
    yieldIndexChunk,
} from "../../shared/sqlite";
import {
    getIndexableContent,
    getLastIndexedOrdinal,
    indexSingleMessage,
    MESSAGE_INDEX_MAX_FTS_BYTES,
    type MessageIndexSource,
    markMessageIndexDirty,
    messageIndexSkipKey,
} from "./message-index";

const IDENTITY_CHUNK_BYTES = 256 * 1024;
export interface IndexWorkerMeasurements {
    holdMs: number[];
    commitMs: number[];
    sourceBytes: number;
    skipped: boolean;
}

/** Large sources keep their identity/progress but cannot create a giant FTS transaction. */
export async function indexMessageInShortChunks(
    db: Database,
    sessionId: string,
    message: RawMessage,
    coordination: { indexCoordination?: SharedArrayBuffer; indexOwner?: number },
    isCurrent: () => boolean,
): Promise<{ inserted: boolean; measurements: IndexWorkerMeasurements }> {
    const measurements: IndexWorkerMeasurements = {
        holdMs: [],
        commitMs: [],
        sourceBytes: 0,
        skipped: false,
    };
    const execute = db.exec.bind(db);
    let beginAt: number | undefined;
    db.exec = ((sql: string) => {
        if (/^BEGIN IMMEDIATE$/.test(sql)) {
            const result = execute(sql);
            beginAt = performance.now();
            return result;
        }
        if (sql === "COMMIT" || sql === "ROLLBACK") {
            const start = performance.now();
            try {
                return execute(sql);
            } finally {
                if (beginAt !== undefined) measurements.holdMs.push(performance.now() - beginAt);
                if (sql === "COMMIT") measurements.commitMs.push(performance.now() - start);
                beginAt = undefined;
            }
        }
        return execute(sql);
    }) as typeof db.exec;
    const transaction = async (write: () => void) =>
        withIndexChunk(coordination, () =>
            withSqliteBackgroundWriter(() => {
                db.exec("BEGIN IMMEDIATE");
                let committed = false;
                try {
                    if (isCurrent()) write();
                    db.exec("COMMIT");
                    committed = true;
                } finally {
                    if (!committed) db.exec("ROLLBACK");
                }
            }),
        );
    try {
        if (!isCurrent()) return { inserted: false, measurements };
        const content = getIndexableContent(message.role, message.parts);
        measurements.sourceBytes = Buffer.byteLength(content);
        const hash = createHash("sha256");
        const oversized = measurements.sourceBytes > MESSAGE_INDEX_MAX_FTS_BYTES;
        measurements.skipped = oversized;
        if (oversized) {
            // The durable floor protects a cancelled or interrupted digest job.
            await transaction(() =>
                markMessageIndexDirty(
                    db,
                    sessionId,
                    Math.min(message.ordinal, getLastIndexedOrdinal(db, sessionId) + 1),
                ),
            );
            const encoded = Buffer.from(content);
            const progress = db.prepare(
                "INSERT INTO schema_migrations_meta(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            );
            for (let offset = 0; offset < encoded.length; offset += IDENTITY_CHUNK_BYTES) {
                if (!isCurrent()) return { inserted: false, measurements };
                const end = Math.min(encoded.length, offset + IDENTITY_CHUNK_BYTES);
                hash.update(encoded.subarray(offset, end));
                await transaction(() =>
                    progress.run(
                        messageIndexSkipKey(sessionId, message.id),
                        JSON.stringify({
                            reason: "oversized",
                            bytes: measurements.sourceBytes,
                            processedBytes: end,
                            ordinal: message.ordinal,
                            sourceVersion: message.version ?? "",
                            complete: false,
                        }),
                    ),
                );
                // The permit is no longer held. A waiting turn wins before the next chunk.
                await yieldIndexChunk();
            }
        } else hash.update(content);
        const source: MessageIndexSource = {
            id: message.id,
            ordinal: message.ordinal,
            role: message.role,
            createdAt: message.createdAt,
            sourceVersion:
                message.version === null || message.version === undefined
                    ? ""
                    : String(message.version),
            contentHash: hash.digest("hex"),
            content: oversized ? "" : content,
            ...(oversized ? { ftsSkippedBytes: measurements.sourceBytes } : {}),
        };
        const inserted = await withIndexChunk(coordination, () =>
            withSqliteBackgroundWriter(() =>
                indexSingleMessage(db, sessionId, message, isCurrent, source),
            ),
        );
        return { inserted, measurements };
    } finally {
        db.exec = execute;
    }
}
