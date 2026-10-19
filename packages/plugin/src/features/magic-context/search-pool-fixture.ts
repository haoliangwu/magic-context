import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { availableParallelism, loadavg, tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "../../shared/sqlite";
import type { StoredCompartmentChunkEmbedding } from "./compartment-chunk-embedding";

/** Synthetic-only schema: no application store, config, or migrations are opened. */
export function searchPoolFixture(
    count = 80,
    dims = 8,
): {
    db: Database;
    path: string;
    add: (id: number, session?: string, project?: string, vector?: Float32Array) => void;
    close: () => void;
} {
    const root = join(tmpdir(), "magic-context/search-pool");
    mkdirSync(root, { recursive: true });
    const directory = mkdtempSync(join(root, "fixture-"));
    const path = join(directory, "fixture.db");
    const db = new Database(path);
    db.exec(`
        PRAGMA journal_mode=WAL;
        CREATE TABLE compartments (id INTEGER PRIMARY KEY, session_id TEXT, title TEXT,
            start_message INTEGER, end_message INTEGER);
        CREATE TABLE message_fts_rowid_map (session_id TEXT, message_ordinal INTEGER,
            message_time_ms INTEGER, PRIMARY KEY(session_id, message_ordinal));
        CREATE TABLE compartment_chunk_embeddings (id INTEGER PRIMARY KEY AUTOINCREMENT,
            compartment_id INTEGER, session_id TEXT, project_path TEXT, window_index INTEGER,
            start_ordinal INTEGER, end_ordinal INTEGER, chunk_hash TEXT, model_id TEXT,
            dims INTEGER, vector BLOB, created_at INTEGER DEFAULT 0, harness TEXT DEFAULT 'opencode');
        CREATE INDEX idx_cce_project_model ON compartment_chunk_embeddings(project_path, model_id);
        CREATE INDEX idx_cce_session ON compartment_chunk_embeddings(session_id);
    `);
    const compartment = db.prepare("INSERT INTO compartments VALUES (?, ?, ?, ?, ?)");
    const timestamp = db.prepare("INSERT INTO message_fts_rowid_map VALUES (?, ?, ?)");
    const insert = db.prepare(
        "INSERT INTO compartment_chunk_embeddings VALUES (NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 'opencode')",
    );
    const add = (id: number, session = "session", project = "/project", vector?: Float32Array) => {
        compartment.run(id, session, `title-${id}`, id * 2, id * 2 + 1);
        timestamp.run(session, id * 2, id * 100);
        timestamp.run(session, id * 2 + 1, id * 100 + 100);
        const values = vector ?? Float32Array.from({ length: dims }, (_, d) => Math.sin(id + d));
        insert.run(
            id,
            session,
            project,
            0,
            id * 2,
            id * 2 + 1,
            `hash-${id}`,
            "model",
            dims,
            new Uint8Array(values.buffer, values.byteOffset, values.byteLength),
        );
    };
    db.transaction(() => {
        for (let id = 1; id <= count; id++) add(id);
    }).immediate();
    return {
        db,
        path,
        add,
        close() {
            db.close();
            rmSync(directory, { recursive: true, force: true });
        },
    };
}

/**
 * Independent pre-cache oracle: session/project/model scope, inclusive endpoint
 * overlap, compartment/window order and copied float32 blobs. Keeping the SQL
 * independent catches cache invalidation and date-filter changes in comparisons.
 * Source baseline: 24bdcc9827fcc936c3f6f1fbfc8c4124c23c555a.
 */
export function baseSearchPool(
    db: Database,
    session = "session",
    project = "/project",
    date: { from: number; to: number } | null = null,
): StoredCompartmentChunkEmbedding[] {
    const rows = db
        .prepare(`SELECT e.compartment_id AS compartmentId, e.session_id AS sessionId,
        c.title, c.start_message AS startOrdinal, c.end_message AS endOrdinal,
        e.window_index AS windowIndex, e.start_ordinal AS windowStartOrdinal,
        e.end_ordinal AS windowEndOrdinal, e.chunk_hash AS chunkHash, e.model_id AS modelId,
        e.dims, e.vector
        FROM compartment_chunk_embeddings e JOIN compartments c ON c.id = e.compartment_id
        ${
            date
                ? `JOIN message_fts_rowid_map start_map ON start_map.session_id = c.session_id
            AND start_map.message_ordinal = c.start_message
            JOIN message_fts_rowid_map end_map ON end_map.session_id = c.session_id
            AND end_map.message_ordinal = c.end_message`
                : ""
        }
        WHERE e.session_id = ? AND e.project_path = ? AND e.model_id = ?
        ${date ? "AND start_map.message_time_ms <= ? AND end_map.message_time_ms >= ?" : ""}
        ORDER BY e.compartment_id ASC, e.window_index ASC`)
        .all(session, project, "model", ...(date ? [date.to, date.from] : [])) as (Omit<
        StoredCompartmentChunkEmbedding,
        "vector"
    > & { vector: Uint8Array })[];
    return rows.map((row) => ({
        ...row,
        vector: new Float32Array(
            row.vector.buffer.slice(
                row.vector.byteOffset,
                row.vector.byteOffset + row.vector.byteLength,
            ),
        ),
    }));
}

export interface SearchHeartbeatOutlier {
    operation: string;
    wallMs: number;
    cpuMs: number;
    cpuSource: string;
    runnerLoadAverage: number[];
    allocatedCPUs: number;
}

function cpuReader() {
    const thread = (process as unknown as { threadCpuUsage?: () => NodeJS.CpuUsage })
        .threadCpuUsage;
    if (thread) {
        try {
            thread.call(process);
            return { source: "thread", read: () => thread.call(process) };
        } catch {
            // Some runtimes expose threadCpuUsage before implementing it.
        }
    }
    return { source: "process-upper-bound", read: () => process.cpuUsage() };
}

const searchCpu = cpuReader();

/** Heartbeat includes first/last slices and samples CPU at the same gap boundaries. */
export async function measureSearchBlock<T>(
    operation: () => Promise<T> | T,
    label = "pool loader",
) {
    let previousCpu = searchCpu.read();
    let previous = performance.now();
    let maximum = 0;
    let cpuMsAtMaximum = 0;
    let maximumCpuMs = 0;
    const outliers: SearchHeartbeatOutlier[] = [];
    let running = true;
    const heartbeat = () => {
        if (!running) return;
        const cpu = searchCpu.read();
        const now = performance.now();
        const wallMs = now - previous;
        const cpuMs = (cpu.user - previousCpu.user + cpu.system - previousCpu.system) / 1000;
        if (wallMs > maximum) {
            maximum = wallMs;
            cpuMsAtMaximum = cpuMs;
        }
        maximumCpuMs = Math.max(maximumCpuMs, cpuMs);
        if (wallMs > 50)
            outliers.push({
                operation: label,
                wallMs,
                cpuMs,
                cpuSource: searchCpu.source,
                runnerLoadAverage: loadavg(),
                allocatedCPUs: availableParallelism(),
            });
        previousCpu = cpu;
        previous = now;
        if (running) setImmediate(heartbeat);
    };
    setImmediate(heartbeat);
    await new Promise<void>((resolve) => setImmediate(resolve));
    const startedCpu = searchCpu.read();
    const started = performance.now();
    try {
        const value = await operation();
        const elapsed = performance.now() - started;
        const finishedCpu = searchCpu.read();
        const totalCpuMs =
            (finishedCpu.user - startedCpu.user + finishedCpu.system - startedCpu.system) / 1000;
        await new Promise<void>((resolve) => setImmediate(resolve));
        return {
            value,
            maximum,
            elapsed,
            totalCpuMs,
            cpuMsAtMaximum,
            maximumCpuMs,
            cpuSource: searchCpu.source,
            outliers,
        };
    } finally {
        running = false;
    }
}
