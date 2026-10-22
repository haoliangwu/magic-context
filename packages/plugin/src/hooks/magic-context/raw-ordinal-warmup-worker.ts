/**
 * Worker entry for the canonical-ordinal warm-up: scans one OpenCode session's
 * messages for compaction-summary rows on its own read-only connection, so the
 * serving thread never reads a whole session's message JSON. See
 * `raw-ordinal-warmup.ts` for the caller.
 */
import { parentPort, workerData } from "node:worker_threads";
import type { RawOrdinalWarmupInput, RawOrdinalWarmupReply } from "./raw-ordinal-warmup";

const port = parentPort;
if (!port) throw new Error("raw ordinal warm-up worker requires a parent port");
const input = workerData as RawOrdinalWarmupInput;
// Report that the thread runs before importing the SQLite and scan modules, so
// the caller's first deadline only has to cover thread start.
port.postMessage({ kind: "accepted" } satisfies RawOrdinalWarmupReply);
const [
    { Database, registerSqliteDiagnosticSink },
    { readRawSessionMessageIdsAtOrdinalsFromDb, scanRawSessionSummaryRows },
    { getHarness, setHarness },
    { log },
] = await Promise.all([
    import("../../shared/sqlite"),
    import("./read-session-raw"),
    import("../../shared/harness"),
    import("../../shared/logger"),
]);
setHarness(input.harness ?? "opencode");
registerSqliteDiagnosticSink(log, getHarness);
let db: InstanceType<typeof Database> | undefined;
let reply: RawOrdinalWarmupReply;
try {
    // The imports above may still be loading after the parent requests termination.
    // Check shared cancellation before opening SQLite; termination itself is asynchronous.
    if (input.openCancellation && Atomics.load(new Int32Array(input.openCancellation), 0) !== 0) {
        throw new Error("warm-up owner closed before database open");
    }
    db =
        input.indexMessage || input.orphanSweep || input.ftsRowidBackfill
            ? new Database(input.path)
            : new Database(input.path, { readonly: true });
    db.exec("PRAGMA busy_timeout = 250");
    if (input.ftsRowidBackfill) {
        const { runMessageFtsRowidMapBackfill } = await import(
            "../../features/magic-context/message-fts-rowid-map"
        );
        // Startup reschedules transient SQLite contention; fail fast instead of waiting for the writer.
        db.exec("PRAGMA busy_timeout = 0");
        await runMessageFtsRowidMapBackfill(db);
        reply = { kind: "fts-rowid-backfill" };
    } else if (input.searchArchive) {
        const { renderSearchArchive } = await import("../../tools/ctx-expand/search-archive");
        const { readRawSessionMessageIdOrdinalsForRangeFromDb } = await import(
            "./read-session-raw"
        );
        const archive = input.searchArchive;
        let raw: InstanceType<typeof Database> | undefined;
        try {
            reply = {
                kind: "search-archive",
                text: renderSearchArchive(
                    db,
                    input.sessionId,
                    archive.start,
                    archive.end,
                    archive.tokenBudget,
                    archive.archiveOnly,
                    () => {
                        if (!archive.rawPath) return new Map(archive.rawIds);
                        raw = new Database(archive.rawPath, { readonly: true });
                        raw.exec("PRAGMA busy_timeout = 250");
                        return readRawSessionMessageIdOrdinalsForRangeFromDb(
                            raw,
                            input.sessionId,
                            archive.start,
                            archive.end,
                        );
                    },
                ),
            };
        } finally {
            raw?.close();
        }
    } else if (input.exactOrdinalIds) {
        reply = {
            kind: "exact-ordinal-ids",
            ids: readRawSessionMessageIdsAtOrdinalsFromDb(
                db,
                input.sessionId,
                input.exactOrdinalIds,
            ),
        };
    } else if (input.orphanSweep) {
        const [
            { setHarness },
            { sweepOrphanedOpenCodeMessageIndexesCooperatively },
            { configureContextDatabasePragmas },
        ] = await Promise.all([
            import("../../shared/harness"),
            import("../../features/magic-context/message-index"),
            import("../../shared/sqlite-context-pragmas"),
        ]);
        setHarness(input.harness ?? "opencode");
        configureContextDatabasePragmas(db);
        const sourcePath = input.orphanSweep.sourcePath;
        reply = {
            kind: "orphan-sweep",
            result: await sweepOrphanedOpenCodeMessageIndexesCooperatively(
                db,
                () => (sourcePath ? new Database(sourcePath, { readonly: true }) : null),
                input.orphanSweep.options,
            ),
        };
    } else if (input.indexMessage) {
        const { setHarness } = await import("../../shared/harness");
        setHarness(input.harness ?? "opencode");
        const [{ indexMessageInShortChunks }, { configureContextDatabasePragmas }] =
            await Promise.all([
                import("../../features/magic-context/message-index-bounded"),
                import("../../shared/sqlite-context-pragmas"),
            ]);
        configureContextDatabasePragmas(db);
        const writer = db;
        const message = input.indexMessage;
        const cancellation = input.indexCancellation
            ? new Int32Array(input.indexCancellation)
            : undefined;
        const result = await indexMessageInShortChunks(
            writer,
            input.sessionId,
            message,
            input,
            () => !cancellation || Atomics.load(cancellation, 0) === 0,
        );
        reply = { kind: "indexed", inserted: result.inserted, measurements: result.measurements };
    } else if (input.tagRatio !== undefined) {
        const { scanTagOwnerSummary, scanTagOwnerDelta } = await import(
            "../../features/magic-context/storage-tags"
        );
        const delta = input.tagState
            ? scanTagOwnerDelta(db, input.sessionId, input.tagState)
            : null;
        if (delta) reply = { kind: "tag-delta", delta };
        else
            reply = {
                kind: "tag-summary",
                summary: scanTagOwnerSummary(db, input.sessionId, input.tagRatio, input.tagRatios),
            };
    } else {
        const scan = scanRawSessionSummaryRows(db, input.sessionId, input.previous);
        reply = { kind: "scan", scan };
    }
} catch (error) {
    const sqliteError = error as { code?: unknown; errcode?: unknown } | null;
    reply = {
        kind: "error",
        error: error instanceof Error ? (error.stack ?? error.message) : String(error),
        code: typeof sqliteError?.code === "string" ? sqliteError.code : undefined,
        errcode: typeof sqliteError?.errcode === "number" ? sqliteError.errcode : undefined,
    };
} finally {
    db?.close();
}
// Release SQLite before publishing: the host may stop the worker on receipt.
port.postMessage(reply);
port.close();
