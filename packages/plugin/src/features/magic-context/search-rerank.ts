import { SubcClient } from "@cortexkit/subc-client";
import { getDefaultSubcConnectionFile } from "../../hooks/magic-context/module-transport";
import { log } from "../../shared/logger";
import type { Database } from "../../shared/sqlite";
import { buildCanonicalChunkTextFromFts } from "./compartment-chunk-embedding";
import type { SynapseClientLike } from "./memory/embedding-synapse";
import type { UnifiedSearchResult } from "./search";

export const RERANK_MODEL = "gte-reranker-modernbert-base-f32";
export const RERANK_LANE_LIMIT = 25;
const DEADLINE_MS = 1500;

/** Rerank questions and multi-word descriptions; prefer the existing ranking for short symbol-heavy lookups. */
export function isProseQuery(query: string): boolean {
    const text = query.trim();
    if (!text || /[\n;]|^["'`]|["'`]$/.test(text)) return false;
    if (
        /^(?:error\b|cannot\b|failed\b|panic\b|traceback\b|assertion\b|SQLITE_|TypeError\b|ReferenceError\b|SyntaxError\b)/i.test(
            text,
        )
    )
        return false;
    if (/\b(?:[A-Z][A-Z_]+:|\w*(?:Error|Exception):)|\bat\s+\S+\s*\(/.test(text)) return false;
    const words = text.replace(/[?!.]$/, "").split(/\s+/);
    if (words.length < 3) return false;
    const plain = words.filter((word) => /^[a-zA-Z]+(?:['’-][a-zA-Z]+)*$/.test(word));
    if (/^(?:how|why|what|where|when|which|who)\b/i.test(text)) return plain.length >= 3;
    // Three ordinary words distinguish descriptive phrases from symbol lists.
    return words.length >= 4 && plain.length >= 3 && !/[\\/]|::|=/.test(text);
}

export type SearchLanes = Record<
    | "memory_fts"
    | "memory_vector"
    | "primer_fts"
    | "primer_vector"
    | "message_fts"
    | "chunk_vector"
    | "git_fts"
    | "git_vector"
    | "notes",
    UnifiedSearchResult[]
>;
export function emptySearchLanes(): SearchLanes {
    return {
        memory_fts: [],
        memory_vector: [],
        primer_fts: [],
        primer_vector: [],
        message_fts: [],
        chunk_vector: [],
        git_fts: [],
        git_vector: [],
        notes: [],
    };
}
export function searchResultKey(hit: UnifiedSearchResult): string {
    switch (hit.source) {
        case "memory":
            return `memory:${hit.memoryId}`;
        case "primer":
            return `primer:${hit.primerId}`;
        case "message":
            return `message:${hit.messageId}`;
        case "compartment":
            return `compartment:${hit.compartmentId}`;
        case "git_commit":
            return `git_commit:${hit.sha}`;
        case "note":
            return `note:${hit.noteId}`;
    }
}

/** Equal-weight RRF; messages covered by a retrieved compartment vote for it. */
export function fuseSearchLanes(lanes: SearchLanes): UnifiedSearchResult[] {
    const compartments = lanes.chunk_vector.filter((hit) => hit.source === "compartment");
    const fused = new Map<string, { hit: UnifiedSearchResult; score: number; order: number }>();
    for (const [name, lane] of Object.entries(lanes)) {
        const seen = new Set<string>();
        lane.slice(0, RERANK_LANE_LIMIT).forEach((original, index) => {
            const hit =
                name === "message_fts" && original.source === "message"
                    ? (compartments.find(
                          (chunk) =>
                              original.messageOrdinal >= chunk.startOrdinal &&
                              original.messageOrdinal <= chunk.endOrdinal,
                      ) ?? original)
                    : original;
            const key = searchResultKey(hit);
            if (seen.has(key)) return;
            seen.add(key);
            const prior = fused.get(key);
            const score = 1 / (60 + index + 1);
            if (prior) prior.score += score;
            else fused.set(key, { hit, score, order: fused.size });
        });
    }
    return [...fused.values()]
        .sort((a, b) => b.score - a.score || a.order - b.order)
        .slice(0, 20)
        .map((row) => row.hit);
}

export function truncateUtf8(text: string, bytes: number): string {
    const buffer = Buffer.from(text);
    let end = Math.min(buffer.length, bytes);
    while (end > 0 && end < buffer.length && (buffer[end] & 0xc0) === 0x80) end--;
    return buffer.subarray(0, end).toString("utf8");
}
export function candidateText(location: string, title: string, body: string): string {
    const header = `${truncateUtf8(location.replaceAll("\n", " "), 200)}\n${truncateUtf8(title.replaceAll("\n", " "), 120)}\n`;
    return header + truncateUtf8(body, 1024 - Buffer.byteLength(header));
}

export interface PinnedReranker {
    fingerprint: string;
    tableEpoch: number;
}
class RerankFailure extends Error {
    constructor(readonly reason: string) {
        super(reason);
    }
}
function unwrap(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== "object") throw new RerankFailure("validation");
    const outer = value as Record<string, unknown>;
    const body = (outer.result ?? outer) as Record<string, unknown>;
    if (!body || typeof body !== "object") throw new RerankFailure("validation");
    if (body.error) {
        const error = body.error as { code?: string };
        throw new RerankFailure(error.code ?? "synapse_error");
    }
    return body;
}
export function pinReranker(value: unknown): PinnedReranker {
    const body = unwrap(value);
    const models = body.models as {
        model_id?: string;
        certified?: boolean;
        fingerprints?: unknown[];
    }[];
    const model = Array.isArray(models)
        ? models.find((row) => row?.model_id === RERANK_MODEL)
        : null;
    if (
        model?.certified !== true ||
        model.fingerprints?.length !== 1 ||
        typeof model.fingerprints[0] !== "string" ||
        !/^[a-f0-9]{64}$/.test(model.fingerprints[0]) ||
        !Number.isSafeInteger(body.table_epoch)
    )
        throw new RerankFailure("catalog_validation");
    return { fingerprint: model.fingerprints[0], tableEpoch: body.table_epoch as number };
}

const loggedReasons = new Set<string>();
export function logRerankFallback(reason: string): void {
    if (loggedReasons.has(reason)) return;
    loggedReasons.add(reason);
    log(`[ctx_search] rerank fallback (${reason}); retaining original ranking`);
}
function reasonOf(error: unknown): string {
    if (error instanceof RerankFailure) return error.reason;
    if (error && typeof error === "object" && "code" in error) {
        const code = String(error.code);
        return ["ENOENT", "ECONNREFUSED"].includes(code) ? "missing_synapse" : code;
    }
    return "synapse_error";
}
async function bounded<T>(promise: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        return await Promise.race([
            promise,
            new Promise<never>((_, reject) => {
                timer = setTimeout(
                    () => reject(new RerankFailure("deadline_exceeded")),
                    DEADLINE_MS,
                );
            }),
        ]);
    } finally {
        clearTimeout(timer);
    }
}
const connections = new Map<string, Promise<SynapseClientLike>>();
async function connect(connectionFile: string): Promise<SynapseClientLike> {
    let connection = connections.get(connectionFile);
    if (!connection) {
        connection = inRootAsyncContext(() => SubcClient.connect({ connectionFile }));
        connections.set(connectionFile, connection);
        void connection.catch(() => connections.delete(connectionFile));
    }
    return bounded(connection);
}
export interface RerankSession {
    client: SynapseClientLike;
    lane: PinnedReranker;
    identity: { project_root: string; harness: string; session: string };
}
/** Discover the certified Synapse model before collecting larger candidate pools, avoiding extra retrieval when the service is absent. */
export async function prepareReranker(
    projectRoot: string,
    sessionId: string,
    connectionFile?: string,
    injectedClient?: SynapseClientLike | null,
): Promise<RerankSession | null> {
    try {
        if (injectedClient === null) throw new RerankFailure("missing_synapse");
        const client =
            injectedClient ?? (await connect(connectionFile ?? getDefaultSubcConnectionFile()));
        const identity = {
            project_root: projectRoot,
            harness: "magic-context",
            session: sessionId,
        };
        const lane = pinReranker(
            await bounded(
                client.call(
                    "synapse",
                    "models.list",
                    {},
                    { timeoutMs: DEADLINE_MS, targetKind: "management_surface", identity },
                ),
            ),
        );
        return { client, lane, identity };
    } catch (error) {
        logRerankFallback(reasonOf(error));
        return null;
    }
}

/** A failure returns the original array, never the poorer fused ranking. */
export async function rerankSearchResults(
    session: RerankSession,
    query: string,
    baseline: UnifiedSearchResult[],
    pool: UnifiedSearchResult[],
    texts: string[],
    limit: number,
): Promise<UnifiedSearchResult[]> {
    if (!pool.length) return baseline;
    try {
        if (
            pool.length > 20 ||
            texts.length !== pool.length ||
            texts.some((text) => Buffer.byteLength(text) > 1024)
        )
            throw new RerankFailure("validation");
        const body = unwrap(
            await bounded(
                session.client.call(
                    "synapse",
                    "rerank.score",
                    {
                        model: RERANK_MODEL,
                        query,
                        candidates: texts,
                        required_fingerprint: session.lane.fingerprint,
                        allow_equivalent: false,
                        accept_declared: false,
                        max_queue_ms: 100,
                        deadline_ms: DEADLINE_MS,
                    },
                    {
                        timeoutMs: DEADLINE_MS,
                        targetKind: "management_surface",
                        identity: session.identity,
                    },
                ),
            ),
        );
        if (body.fingerprint !== session.lane.fingerprint)
            throw new RerankFailure("fingerprint_mismatch");
        if (body.table_epoch !== session.lane.tableEpoch) throw new RerankFailure("epoch_mismatch");
        if (
            !Array.isArray(body.scores) ||
            body.scores.length !== pool.length ||
            body.scores.some((score) => typeof score !== "number" || !Number.isFinite(score))
        )
            throw new RerankFailure("validation");
        const scores = body.scores as number[];
        return pool
            .map((hit, index) => ({ hit, index, score: scores[index] }))
            .sort((a, b) => b.score - a.score || a.index - b.index)
            .slice(0, limit)
            .map((row) => row.hit);
    } catch (error) {
        logRerankFallback(reasonOf(error));
        return baseline;
    }
}

export function candidateTexts(
    db: Database,
    sessionId: string,
    projectPath: string,
    pool: UnifiedSearchResult[],
): string[] {
    return pool.map((hit) => {
        const id = searchResultKey(hit).split(":").slice(1).join(":");
        let location = `${hit.source} ${id} ${projectPath}`;
        let title = hit.content.split("\n")[0];
        let body = hit.content;
        switch (hit.source) {
            case "memory": {
                const row = db
                    .prepare("SELECT content FROM memories WHERE id=?")
                    .get(hit.memoryId) as { content: string };
                body = row.content;
                title = body.split("\n")[0];
                break;
            }
            case "primer": {
                const row = db
                    .prepare("SELECT question, answer FROM primers WHERE id=?")
                    .get(hit.primerId) as { question: string; answer: string };
                title = row.question;
                body = `Q: ${row.question}\nA: ${row.answer}`;
                break;
            }
            case "git_commit": {
                const row = db
                    .prepare("SELECT message FROM git_commits WHERE sha=?")
                    .get(hit.sha) as { message: string };
                body = row.message;
                title = `${hit.shortSha} ${body.split("\n")[0]}`;
                break;
            }
            case "note": {
                const row = db
                    .prepare("SELECT content, ready_reason AS reason FROM notes WHERE id=?")
                    .get(hit.noteId) as { content: string; reason: string | null };
                body = `${row.content}${row.reason ? `\nReason: ${row.reason}` : ""}`;
                title = body.split("\n")[0];
                break;
            }
            case "message": {
                // The ordinal map avoids scanning the FTS table's unindexed identity columns.
                const mapped = db
                    .prepare(`SELECT f.content FROM message_fts_rowid_map m
                    JOIN message_history_fts f ON f.rowid=m.fts_rowid
                    WHERE m.session_id=? AND m.message_ordinal=? AND f.message_id=?`)
                    .get(sessionId, hit.messageOrdinal, hit.messageId) as
                    | { content: string }
                    | undefined;
                const row =
                    mapped ??
                    (db
                        .prepare(
                            "SELECT content FROM message_history_fts WHERE session_id=? AND message_id=? ORDER BY CAST(message_ordinal AS INTEGER) LIMIT 1",
                        )
                        .get(sessionId, hit.messageId) as { content: string });
                body = row.content;
                title = `${hit.role}: ${body.split("\n")[0]}`;
                location = `message ${hit.messageId} ${sessionId} @${hit.messageOrdinal}`;
                break;
            }
            case "compartment": {
                title = hit.title;
                location = `compartment ${hit.compartmentId} ${hit.sessionId} @${hit.startOrdinal}-${hit.endOrdinal}`;
                body =
                    buildCanonicalChunkTextFromFts(
                        db,
                        hit.sessionId,
                        hit.startOrdinal,
                        hit.endOrdinal,
                    ) ?? "";
                break;
            }
        }
        return candidateText(location, title, body);
    });
}

import { inRootAsyncContext } from "../../shared/sqlite";
