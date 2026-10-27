/**
 * Synthetic auto-search latency bench for a large session: about 20k stored
 * chunk embeddings of 1024 dimensions (about 85 MB of vectors, the size
 * reported for two long sessions) and 30k indexed messages.
 *
 * It never opens a host store or reads host configuration: the database, the
 * log file and an embedding endpoint all live under a throwaway directory. The
 * endpoint is a local HTTP server that answers each query after a delay drawn
 * from a log-normal distribution fitted to measured Voyage round trips
 * (median 293 ms, 90th percentile 675 ms), with a fixed seed.
 *
 * Each turn calls the production runner (`runAutoSearchHint`) for a new user
 * message and times the whole call, so worker start, the deadline and the
 * search worker's pool all count. Run with:
 *   bun packages/plugin/scripts/experiments/issue-762-auto-search-bench.ts [--turns=40]
 */
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CHUNKS = Number(
    process.argv.find((value) => value.startsWith("--chunks="))?.slice("--chunks=".length) ??
        20_500,
);
const WINDOWS_PER_COMPARTMENT = 10;
const DIMS = 1024;
const MESSAGES = 30_000;
const turns = Number(
    process.argv.find((value) => value.startsWith("--turns="))?.slice("--turns=".length) ?? 40,
);
// The first query answers this fast, so the first turn has a query vector while
// no pool is loaded yet: the cold-pool case.
const firstLatencyMs = Number(
    process.argv
        .find((value) => value.startsWith("--first-latency-ms="))
        ?.slice("--first-latency-ms=".length) ?? 20,
);
const gapMs = Number(
    process.argv.find((value) => value.startsWith("--gap-ms="))?.slice("--gap-ms=".length) ?? 300,
);

const parent = join(process.env.TMPDIR ?? tmpdir(), "magic-context", "issue-762-bench");
mkdirSync(parent, { recursive: true });
const root = mkdtempSync(join(parent, "run-"));
// Point the logger at the throwaway root before any plugin module loads.
process.env.MAGIC_CONTEXT_LOG_PATH = join(root, "plugin.log");

const [
    { Database },
    { initializeDatabase },
    { runMigrations },
    { registerProjectEmbedding, unregisterProjectEmbedding },
    { runAutoSearchHint, _resetAutoSearchCache },
    { loadCompartmentChunkEmbeddingsForSearch, _getCompartmentChunkSearchCacheStatsForTests },
] = await Promise.all([
    import("../../src/shared/sqlite"),
    import("../../src/features/magic-context/storage-db"),
    import("../../src/features/magic-context/migrations"),
    import("../../src/features/magic-context/project-embedding-registry"),
    import("../../src/hooks/magic-context/auto-search-runner"),
    import("../../src/features/magic-context/compartment-chunk-embedding"),
]);

function mulberry32(seed: number): () => number {
    let state = seed >>> 0;
    return () => {
        state = (state + 0x6d2b79f5) >>> 0;
        let t = state;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}
const random = mulberry32(762);
const gaussian = () => {
    const u = Math.max(random(), 1e-12);
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * random());
};
// Log-normal through the measured median and 90th percentile.
const MEDIAN_MS = 293;
const P90_MS = 675;
const SIGMA = Math.log(P90_MS / MEDIAN_MS) / 1.2815515655446004;
const latencyRandom = mulberry32(293);
const latencyGaussian = () => {
    const u = Math.max(latencyRandom(), 1e-12);
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * latencyRandom());
};
const sampleLatency = () => MEDIAN_MS * Math.exp(SIGMA * latencyGaussian());

function unitVector(seedVector?: Float32Array, noise = 1): Float32Array {
    const vector = new Float32Array(DIMS);
    let norm = 0;
    for (let d = 0; d < DIMS; d++) {
        vector[d] = (seedVector?.[d] ?? 0) + noise * gaussian();
        norm += vector[d] * vector[d];
    }
    norm = Math.sqrt(norm);
    for (let d = 0; d < DIMS; d++) vector[d] /= norm;
    return vector;
}

const queryVector = unitVector();
const queryEmbedding = Array.from(queryVector);
const providerLatencies: number[] = [];
let forcedLatencyMs: number | undefined;
const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
        const body = (await request.json()) as { input: string[] };
        const latency =
            forcedLatencyMs ?? (providerLatencies.length === 0 ? firstLatencyMs : sampleLatency());
        providerLatencies.push(latency);
        await Bun.sleep(latency);
        return Response.json({
            data: body.input.map((_text, index) => ({ index, embedding: queryEmbedding })),
        });
    },
});

const db = new Database(join(root, "context.db"));
initializeDatabase(db);
runMigrations(db);
const projectPath = "git:issue-762-bench";
const sessionId = "issue-762-session";
const snapshot = registerProjectEmbedding(
    db,
    projectPath,
    {
        provider: "openai-compatible",
        endpoint: `http://127.0.0.1:${server.port}/v1`,
        model: "fixture",
    },
    // The report ran with memory disabled; history search still embeds.
    { memoryEnabled: false, gitCommitEnabled: false },
    root,
);

const fixtureStarted = performance.now();
const insertMessage = db.prepare(
    "INSERT INTO message_history_fts (session_id,message_ordinal,message_id,role,content) VALUES (?,?,?,?,?)",
);
const insertMap = db.prepare(
    "INSERT INTO message_fts_rowid_map (session_id,message_ordinal,fts_rowid) VALUES (?,?,?)",
);
const insertCompartment = db.prepare(
    "INSERT INTO compartments (session_id,sequence,start_message,end_message,title,content,created_at) VALUES (?,?,?,?,?,?,?)",
);
const insertChunk = db.prepare(
    "INSERT INTO compartment_chunk_embeddings (compartment_id,session_id,project_path,window_index,start_ordinal,end_ordinal,chunk_hash,model_id,dims,vector,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
);
const words = "TypeScript query embedding timeout SQLite context budget tool result worker pool";
db.transaction(() => {
    for (let ordinal = 1; ordinal <= MESSAGES; ordinal++) {
        const topical = ordinal % 10 === 0 ? "historian cache wiring status " : "";
        const content = `${topical}message ${ordinal} ${words} `.repeat(6);
        const row = insertMessage.run(
            sessionId,
            ordinal,
            `msg-${ordinal}`,
            ordinal % 2 ? "user" : "assistant",
            content,
        );
        insertMap.run(sessionId, ordinal, row.lastInsertRowid);
    }
    const compartments = CHUNKS / WINDOWS_PER_COMPARTMENT;
    const span = Math.floor(MESSAGES / compartments) - 1;
    for (let index = 0; index < compartments; index++) {
        const start = index * (span + 1) + 1;
        const end = start + span;
        // A few compartments sit close to the query so the chunk lane has a hit.
        const near = index % 97 === 0;
        const compartment = insertCompartment.run(
            sessionId,
            index,
            start,
            end,
            near ? `Historian cache wiring compartment ${index}` : `Compartment ${index}`,
            "fixture summary",
            1_700_000_000_000,
        );
        for (let window = 0; window < WINDOWS_PER_COMPARTMENT; window++) {
            const vector = near ? unitVector(queryVector, 0.03) : unitVector();
            insertChunk.run(
                compartment.lastInsertRowid,
                sessionId,
                projectPath,
                window,
                start,
                end,
                `hash-${index}-${window}`,
                snapshot.chunkModelId,
                DIMS,
                Buffer.from(vector.buffer),
                1_700_000_000_000,
            );
        }
    }
}).immediate();
// Fold the fixture's write-ahead log into the database now, so the first
// turn's decision write does not pay for checkpointing the whole fixture.
db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
const fixtureMs = performance.now() - fixtureStarted;

interface TurnSample {
    turn: number;
    ms: number;
    hint: boolean;
    chunkHit: boolean;
}
const samples: TurnSample[] = [];
async function turn(index: number): Promise<TurnSample> {
    const messages = [
        {
            info: { id: `turn-${index}`, role: "user" },
            parts: [{ type: "text", text: "explain the historian cache wiring status" }],
        },
    ];
    const started = performance.now();
    await runAutoSearchHint({
        db,
        sessionId,
        messages,
        options: { enabled: true, scoreThreshold: 0.6, minPromptChars: 10, projectPath },
    });
    const ms = performance.now() - started;
    const text = messages[0].parts[0].text;
    return {
        turn: index,
        ms,
        hint: text.includes("<ctx-search-hint>"),
        chunkHit: /compartment \d+/i.test(text.slice(text.indexOf("<ctx-search-hint>") + 1)),
    };
}

const percentile = (values: number[], p: number) => {
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] ?? 0;
};
const summarize = (rows: TurnSample[]) => ({
    turns: rows.length,
    p50Ms: Number(percentile(rows.map((row) => row.ms), 50).toFixed(1)),
    p95Ms: Number(percentile(rows.map((row) => row.ms), 95).toFixed(1)),
    maxMs: Number(Math.max(...rows.map((row) => row.ms)).toFixed(1)),
    overDeadline: rows.filter((row) => row.ms >= 1000).length,
    hints: rows.filter((row) => row.hint).length,
    chunkHits: rows.filter((row) => row.chunkHit).length,
});

try {
    // The first turn finds no search worker and no decoded pool.
    samples.push(await turn(0));
    // An idle gap between turns, as between a reply and the next prompt.
    await Bun.sleep(3000);
    for (let index = 1; index <= turns; index++) {
        samples.push(await turn(index));
        await Bun.sleep(gapMs);
    }
    const warm = samples.slice(1);
    // A compartment is published (ten new chunk rows) and the next turns come
    // at once with a fast query vector, so they find the loaded pool stale.
    const published = insertCompartment.run(
        sessionId,
        CHUNKS,
        MESSAGES - 10,
        MESSAGES,
        `Historian cache wiring compartment ${CHUNKS}`,
        "fixture summary",
        1_700_000_000_000,
    );
    for (let window = 0; window < WINDOWS_PER_COMPARTMENT; window++) {
        const vector = unitVector(queryVector, 0.03);
        insertChunk.run(
            published.lastInsertRowid,
            sessionId,
            projectPath,
            window,
            MESSAGES - 10,
            MESSAGES,
            `hash-published-${window}`,
            snapshot.chunkModelId,
            DIMS,
            Buffer.from(vector.buffer),
            1_700_000_000_000,
        );
    }
    forcedLatencyMs = 20;
    const stale: TurnSample[] = [];
    for (let index = 0; index < 5; index++) stale.push(await turn(turns + 1 + index));
    forcedLatencyMs = undefined;
    // The same cold pool build the search worker does, timed on this thread.
    const buildStarted = performance.now();
    const pool = await loadCompartmentChunkEmbeddingsForSearch(
        db,
        sessionId,
        projectPath,
        snapshot.chunkModelId,
    );
    const coldBuild = {
        ms: Math.round(performance.now() - buildStarted),
        rows: pool.length,
        probeMs: Math.round(_getCompartmentChunkSearchCacheStatsForTests().probeMs),
    };
    // What a hint turn pays to learn whether the pool is warm (absent on base).
    const chunkModule = (await import(
        "../../src/features/magic-context/compartment-chunk-embedding"
    )) as { peekCompartmentChunkSearchPool?: (...args: unknown[]) => unknown };
    let warmCheckMs: number | null = null;
    if (chunkModule.peekCompartmentChunkSearchPool) {
        const checks: number[] = [];
        for (let index = 0; index < 20; index++) {
            const started = performance.now();
            chunkModule.peekCompartmentChunkSearchPool(
                db,
                sessionId,
                projectPath,
                snapshot.chunkModelId,
            );
            checks.push(performance.now() - started);
        }
        warmCheckMs = Number(percentile(checks, 50).toFixed(2));
    }
    console.log(
        JSON.stringify(
            {
                runtime: `Bun ${Bun.version}`,
                fixture: {
                    chunks: CHUNKS,
                    dims: DIMS,
                    messages: MESSAGES,
                    vectorMb: Number(((CHUNKS * DIMS * 4) / 1e6).toFixed(1)),
                    buildMs: Math.round(fixtureMs),
                },
                provider: {
                    requests: providerLatencies.length,
                    p50Ms: Math.round(percentile(providerLatencies, 50)),
                    p90Ms: Math.round(percentile(providerLatencies, 90)),
                },
                coldPoolBuild: coldBuild,
                warmCheckP50Ms: warmCheckMs,
                coldTurn: samples[0],
                afterIdle: summarize(warm),
                afterIdleFirstFive: warm.slice(0, 5).map((row) => Math.round(row.ms)),
                stalePoolTurnsFastVector: stale.map((row) => ({
                    ms: Math.round(row.ms),
                    chunkHit: row.chunkHit,
                })),
            },
            null,
            2,
        ),
    );
} finally {
    _resetAutoSearchCache();
    unregisterProjectEmbedding(projectPath);
    db.close();
    server.stop(true);
    rmSync(root, { recursive: true, force: true });
}
// Pooled search workers are unreferenced; exit without waiting for their idle timers.
process.exit(0);
