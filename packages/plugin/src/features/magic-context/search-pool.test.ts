import { expect, spyOn, test } from "bun:test";
import { scaleTest, slowOnlyTest } from "../../shared/slow-test";
import { Database } from "../../shared/sqlite";
import {
    _getCompartmentChunkSearchCacheStatsForTests,
    _resetCompartmentChunkSearchCacheForTests,
    loadCompartmentChunkEmbeddingsForSearch,
    peekCompartmentChunkSearchPool,
    type StoredCompartmentChunkEmbedding,
    warmCompartmentChunkSearchPool,
} from "./compartment-chunk-embedding";
import { cosineSimilarity } from "./memory/embedding";
import { baseSearchPool, measureSearchBlock, searchPoolFixture } from "./search-pool-fixture";

const load = (db: Database, date: { from: number; to: number } | null = null) =>
    loadCompartmentChunkEmbeddingsForSearch(db, "session", "/project", "model", date);

function replaceVectorAtId(db: Database, id: number, vector: Float32Array, hash?: string): void {
    const row = db.prepare("SELECT * FROM compartment_chunk_embeddings WHERE id = ?").get(id) as
        | Record<string, string | number | Uint8Array | null>
        | undefined;
    if (!row) return;
    db.transaction(() => {
        db.prepare("DELETE FROM compartment_chunk_embeddings WHERE id = ?").run(id);
        db.prepare(`INSERT INTO compartment_chunk_embeddings
            (compartment_id, session_id, project_path, window_index, start_ordinal, end_ordinal,
             chunk_hash, model_id, dims, vector, created_at, harness) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
            row.compartment_id,
            row.session_id,
            row.project_path,
            row.window_index,
            row.start_ordinal,
            row.end_ordinal,
            hash ?? row.chunk_hash,
            row.model_id,
            vector.length,
            new Uint8Array(vector.buffer),
            row.created_at,
            row.harness,
        );
    }).immediate();
}

test("append rejects a changed prefix row even when count and max look append-only", async () => {
    const fixture = searchPoolFixture();
    try {
        await load(fixture.db);
        replaceVectorAtId(fixture.db, 1, new Float32Array(8).fill(0.75));
        fixture.add(81);
        const rows = await load(fixture.db);
        expect([...rows[0].vector]).toEqual(Array(8).fill(0.75));
        expect(rows).toHaveLength(81);
    } finally {
        fixture.close();
        _resetCompartmentChunkSearchCacheForTests();
    }
});

test("dated pool includes both overlap boundary rows and excludes missing or null endpoints", async () => {
    const fixture = searchPoolFixture(4);
    try {
        const warm = await load(fixture.db);
        fixture.db.prepare("DELETE FROM message_fts_rowid_map WHERE message_ordinal = 6").run();
        fixture.db
            .prepare(
                "UPDATE message_fts_rowid_map SET message_time_ms = NULL WHERE message_ordinal = 8",
            )
            .run();
        const dated = await load(fixture.db, { from: 200, to: 200 });
        expect(dated.map((row) => row.compartmentId)).toEqual([1, 2]);
        expect(dated).toEqual(
            baseSearchPool(fixture.db, "session", "/project", { from: 200, to: 200 }),
        );
        expect(warm).toHaveLength(4);
    } finally {
        fixture.close();
        _resetCompartmentChunkSearchCacheForTests();
    }
});

test("pure append retains decoded prefix vectors and original compartment/window ordering", async () => {
    const fixture = searchPoolFixture();
    try {
        const first = await load(fixture.db);
        fixture.add(81);
        const appended = await load(fixture.db);
        expect(appended).toHaveLength(81);
        expect(appended[0].vector).toBe(first[0].vector);
        expect(appended).toEqual(baseSearchPool(fixture.db));
        expect(first).toHaveLength(80);
    } finally {
        fixture.close();
        _resetCompartmentChunkSearchCacheForTests();
    }
});

test("in-scope delete plus insert keeping count re-decodes the replaced row", async () => {
    const fixture = searchPoolFixture();
    try {
        const first = await load(fixture.db);
        fixture.db.prepare("DELETE FROM compartment_chunk_embeddings WHERE id = 1").run();
        fixture.db
            .prepare(`INSERT INTO compartment_chunk_embeddings
            SELECT NULL, 1, session_id, project_path, 0, 2, 3, 'replacement', model_id, dims, vector, created_at, harness
            FROM compartment_chunk_embeddings WHERE id = 2`)
            .run();
        const decodedBefore = _getCompartmentChunkSearchCacheStatsForTests().rowsDecoded;
        const replaced = await load(fixture.db);
        expect(replaced).toHaveLength(first.length);
        expect(replaced).toEqual(baseSearchPool(fixture.db));
        // The replacement row (compartment 1) carries compartment 2's vector and
        // is decoded afresh; the untouched rows keep their decoded vectors.
        expect(replaced[0].vector).not.toBe(first[0].vector);
        expect([...replaced[0].vector]).toEqual([...first[1].vector]);
        expect(replaced[1].vector).toBe(first[1].vector);
        expect(_getCompartmentChunkSearchCacheStatsForTests().rowsDecoded - decodedBefore).toBe(1);
    } finally {
        fixture.close();
        _resetCompartmentChunkSearchCacheForTests();
    }
});

test("out-of-scope commits preserve decoded vectors including other-table and other-session writes", async () => {
    const fixture = searchPoolFixture();
    const writer = new Database(fixture.path);
    try {
        writer.exec("CREATE TABLE unrelated_activity (value INTEGER)");
        const first = await load(fixture.db);
        const stats = _getCompartmentChunkSearchCacheStatsForTests();
        writer.prepare("INSERT INTO unrelated_activity VALUES (?)").run(1);
        fixture.add(81, "other-session", "/other-project");
        fixture.add(82, "other-session", "/project");
        fixture.add(83, "session", "/other-project");
        const warm = await load(fixture.db);
        expect(warm).toEqual(baseSearchPool(fixture.db));
        expect(warm[0].vector).toBe(first[0].vector);
        expect(_getCompartmentChunkSearchCacheStatsForTests().fullRebuilds).toBe(
            stats.fullRebuilds,
        );
    } finally {
        writer.close();
        fixture.close();
        _resetCompartmentChunkSearchCacheForTests();
    }
});

test("project scope never reads another project's vector payload", async () => {
    const fixture = searchPoolFixture();
    const cleanups: (() => void)[] = [];
    let vectorRows = 0;
    let vectorBytes = 0;
    const prepare = fixture.db.prepare.bind(fixture.db);
    const observePrepare = (sql: string) => {
        const statement = prepare(sql);
        if (sql.includes("e.vector AS vector")) {
            const all = statement.all.bind(statement);
            const spy = spyOn(statement, "all").mockImplementation((...args: unknown[]) => {
                const rows = all(...args) as { vector: Uint8Array | ArrayBuffer }[];
                vectorRows += rows.length;
                vectorBytes += rows.reduce((bytes, row) => bytes + row.vector.byteLength, 0);
                return rows;
            });
            cleanups.push(() => spy.mockRestore());
        }
        return statement;
    };
    const observer = spyOn(fixture.db, "prepare").mockImplementation(
        observePrepare as typeof fixture.db.prepare,
    );
    try {
        // Put the foreign row below this scope's maximum id so the keyset bound
        // cannot hide a missing project predicate.
        replaceVectorAtId(
            fixture.db,
            2,
            Float32Array.from({ length: 8 }, (_, d) => Math.sin(2 + d)),
        );
        fixture.db
            .prepare(
                "INSERT INTO compartments VALUES (999, 'session', 'other project', 1998, 1999)",
            )
            .run();
        fixture.db
            .prepare(`INSERT INTO compartment_chunk_embeddings VALUES
            (2, 999, 'session', '/other-project', 0, 1998, 1999, 'other', 'model', 8, ?, 0, 'opencode')`)
            .run(new Uint8Array([1, 2, 3]));
        expect(await load(fixture.db)).toEqual(baseSearchPool(fixture.db));
        expect(vectorRows).toBe(80);
        expect(vectorBytes).toBe(80 * 8 * 4);
    } finally {
        for (const cleanup of cleanups) cleanup();
        observer.mockRestore();
        fixture.close();
        _resetCompartmentChunkSearchCacheForTests();
    }
});

test("a pool evicted during its probe is rebuilt with accounted LRU bytes", async () => {
    _resetCompartmentChunkSearchCacheForTests();
    const fixture = searchPoolFixture(0, 4096);
    const cleanups: (() => void)[] = [];
    const overlap: { promise?: Promise<StoredCompartmentChunkEmbedding[]> } = {};
    let largeLoading = false;
    let revisionReads = 0;
    const prepare = fixture.db.prepare.bind(fixture.db);
    const observePrepare = (sql: string) => {
        const statement = prepare(sql);
        if (sql.includes("total_changes()")) {
            const get = statement.get.bind(statement);
            const spy = spyOn(statement, "get").mockImplementation((...args: unknown[]) => {
                // A refresh reads the write counters before its probe and again
                // after its last read, immediately before it caches (and here
                // evicts). Begin the small probe at the large refresh's second
                // read, so it overlaps the eviction.
                if (largeLoading && !overlap.promise && ++revisionReads === 2) {
                    largeLoading = false;
                    overlap.promise = load(fixture.db);
                }
                return get(...(args as []));
            });
            cleanups.push(() => spy.mockRestore());
        }
        return statement;
    };
    const observer = spyOn(fixture.db, "prepare").mockImplementation(
        observePrepare as typeof fixture.db.prepare,
    );
    try {
        fixture.db
            .transaction(() => {
                fixture.add(1);
                // These vectors alone fill 256 MiB; metadata makes the pool too big
                // to retain, so inserting it evicts both it and the small pool.
                for (let id = 2; id <= 16385; id++)
                    fixture.add(id, "other-session", "/other-project");
            })
            .immediate();
        await load(fixture.db);
        const initialBytes = _getCompartmentChunkSearchCacheStatsForTests().bytes;
        largeLoading = true;
        const large = await loadCompartmentChunkEmbeddingsForSearch(
            fixture.db,
            "other-session",
            "/other-project",
            "model",
        );
        expect(large).toHaveLength(16384);
        const joining = overlap.promise;
        if (!joining) throw new Error("Warm probe did not overlap the oversized pool's eviction");
        expect(await joining).toHaveLength(1);
        expect(_getCompartmentChunkSearchCacheStatsForTests().bytes).toBe(initialBytes);
    } finally {
        for (const cleanup of cleanups) cleanup();
        observer.mockRestore();
        fixture.close();
        _resetCompartmentChunkSearchCacheForTests();
    }
}, 60000);

test("in-place metadata changes rebuild even when rowid and window-index sums stay equal", async () => {
    const fixture = searchPoolFixture(3);
    try {
        fixture.db
            .prepare("UPDATE compartment_chunk_embeddings SET window_index = 1 WHERE id = 2")
            .run();
        const first = await load(fixture.db);
        fixture.db
            .prepare(`UPDATE compartment_chunk_embeddings SET window_index =
            CASE id WHEN 1 THEN 1 ELSE 0 END WHERE id IN (1, 2)`)
            .run();
        const changed = await load(fixture.db);
        expect(changed).toEqual(baseSearchPool(fixture.db));
        expect(changed[0].vector).not.toBe(first[0].vector);
        fixture.db
            .prepare("UPDATE compartment_chunk_embeddings SET harness = 'opencode2' WHERE id = 3")
            .run();
        // Only the edited row is read again; the others keep their decoded vectors.
        const third = await load(fixture.db);
        expect(third).toEqual(baseSearchPool(fixture.db));
        expect(third[2].vector).not.toBe(changed[2].vector);
        expect(third[0].vector).toBe(changed[0].vector);
    } finally {
        fixture.close();
        _resetCompartmentChunkSearchCacheForTests();
    }
});

test("other connections, low-id inserts, deletes and concurrent rebuilds never return a partial pool", async () => {
    const fixture = searchPoolFixture(80);
    const writer = new Database(fixture.path);
    try {
        await load(fixture.db);
        writer
            .prepare("UPDATE compartment_chunk_embeddings SET chunk_hash = 'external' WHERE id = 1")
            .run();
        expect((await load(fixture.db))[0].chunkHash).toBe("external");
        writer.prepare("DELETE FROM compartment_chunk_embeddings WHERE id = 2").run();
        await load(fixture.db);
        fixture.db
            .prepare(`INSERT INTO compartment_chunk_embeddings
             SELECT 2, 2, session_id, project_path, 0, 4, 5, chunk_hash, model_id, dims, vector, created_at, harness
            FROM compartment_chunk_embeddings WHERE id = 1`)
            .run();
        const inFlight = load(fixture.db);
        await new Promise<void>((resolve) => setImmediate(resolve));
        fixture.db
            .prepare("UPDATE compartment_chunk_embeddings SET chunk_hash = 'raced' WHERE id = 3")
            .run();
        const rows = await Promise.all([inFlight, load(fixture.db), load(fixture.db)]);
        for (const pool of rows) expect(pool).toEqual(baseSearchPool(fixture.db));
    } finally {
        writer.close();
        fixture.close();
        _resetCompartmentChunkSearchCacheForTests();
    }
});

test("rolled-back transaction-local vectors never escape through a cached pool", async () => {
    const fixture = searchPoolFixture(3);
    try {
        const original = await load(fixture.db);
        fixture.db.exec("BEGIN");
        fixture.db
            .prepare(
                "UPDATE compartment_chunk_embeddings SET chunk_hash = 'temporary' WHERE id = 1",
            )
            .run();
        expect((await load(fixture.db))[0].chunkHash).toBe("temporary");
        fixture.db.exec("ROLLBACK");
        expect((await load(fixture.db))[0].chunkHash).toBe(original[0].chunkHash);
    } finally {
        fixture.close();
        _resetCompartmentChunkSearchCacheForTests();
    }
});

test("a warm pool is served without a probe and a changed session reads as cold", async () => {
    const fixture = searchPoolFixture();
    try {
        const peek = () =>
            peekCompartmentChunkSearchPool(fixture.db, "session", "/project", "model");
        expect(peek()).toBeNull();
        expect(
            (await warmCompartmentChunkSearchPool(fixture.db, "session", "/project", "model"))
                .outcome,
        ).toBe("refreshed");
        const stats = _getCompartmentChunkSearchCacheStatsForTests();
        expect(peek()).toEqual(baseSearchPool(fixture.db));
        expect(_getCompartmentChunkSearchCacheStatsForTests().probePages).toBe(stats.probePages);
        // Rows of another project or model in the same session also change the
        // session's signature; the warm then finds the scope itself unchanged.
        fixture.add(81, "session", "/other-project");
        expect(peek()).toBeNull();
        await warmCompartmentChunkSearchPool(fixture.db, "session", "/project", "model");
        expect(peek()).toEqual(baseSearchPool(fixture.db));
    } finally {
        fixture.close();
        _resetCompartmentChunkSearchCacheForTests();
    }
});

test("a background warm after an append probes and decodes only the new rows", async () => {
    const fixture = searchPoolFixture();
    try {
        await warmCompartmentChunkSearchPool(fixture.db, "session", "/project", "model");
        const first = peekCompartmentChunkSearchPool(fixture.db, "session", "/project", "model");
        const stats = _getCompartmentChunkSearchCacheStatsForTests();
        fixture.add(81);
        fixture.add(82);
        const report = await warmCompartmentChunkSearchPool(
            fixture.db,
            "session",
            "/project",
            "model",
        );
        const after = _getCompartmentChunkSearchCacheStatsForTests();
        expect({
            outcome: report.outcome,
            decodedRows: report.decodedRows,
            fullProbes: after.probes - stats.probes,
            tailProbes: after.tailProbes - stats.tailProbes,
            endProbes: after.endProbes - stats.endProbes,
        }).toEqual({
            outcome: "refreshed",
            decodedRows: 2,
            fullProbes: 0,
            tailProbes: 1,
            endProbes: 0,
        });
        const warm = peekCompartmentChunkSearchPool(fixture.db, "session", "/project", "model");
        expect(warm).toEqual(baseSearchPool(fixture.db));
        expect(warm?.[0].vector).toBe(first?.[0].vector);
    } finally {
        fixture.close();
        _resetCompartmentChunkSearchCacheForTests();
    }
});

test("an aborted load stops between batches and caches nothing", async () => {
    const fixture = searchPoolFixture(200);
    try {
        const decodedBefore = _getCompartmentChunkSearchCacheStatsForTests().rowsDecoded;
        const controller = new AbortController();
        const pending = loadCompartmentChunkEmbeddingsForSearch(
            fixture.db,
            "session",
            "/project",
            "model",
            null,
            controller.signal,
        );
        controller.abort();
        await expect(pending).rejects.toThrow();
        expect(_getCompartmentChunkSearchCacheStatsForTests().rowsDecoded).toBe(decodedBefore);
        expect(
            peekCompartmentChunkSearchPool(fixture.db, "session", "/project", "model"),
        ).toBeNull();
        // A later caller without a signal is not affected by the aborted one.
        expect(await load(fixture.db)).toEqual(baseSearchPool(fixture.db));
    } finally {
        fixture.close();
        _resetCompartmentChunkSearchCacheForTests();
    }
});

function rank(rows: StoredCompartmentChunkEmbedding[], query: Float32Array, cutoff: number) {
    const winners = new Map<number, { id: number; ordinal: number; score: number }>();
    for (const row of rows) {
        if (row.endOrdinal > cutoff) continue;
        const score = Math.min(1, Math.max(0, cosineSimilarity(query, row.vector)));
        if (score <= 0) continue;
        const prior = winners.get(row.compartmentId);
        if (!prior || score > prior.score)
            winners.set(row.compartmentId, {
                id: row.compartmentId,
                ordinal: row.startOrdinal,
                score,
            });
    }
    return [...winners.values()]
        .sort((a, b) => b.score - a.score || a.ordinal - b.ordinal)
        .slice(0, 25)
        .map(({ id, score }) => ({ id, score: score * 0.8 }));
}

test("250 seeded searches equal base SQL rows, ids, ordering and exact scores after mutations", async () => {
    const fixture = searchPoolFixture();
    let seed = 0x19c0ffee;
    const random = () => {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        return seed / 2 ** 32;
    };
    try {
        for (let i = 0; i < 250; i++) {
            const id = 1 + Math.floor(random() * 80);
            switch (i % 7) {
                case 0:
                    fixture.add(
                        81 + i,
                        i % 2 ? "other-session" : "session",
                        i % 3 ? "/other" : "/project",
                    );
                    break;
                case 1:
                    fixture.db
                        .prepare("DELETE FROM compartment_chunk_embeddings WHERE id = ?")
                        .run(id);
                    break;
                case 2:
                    replaceVectorAtId(
                        fixture.db,
                        id,
                        Float32Array.from({ length: 8 }, () => random() - 0.5),
                        `new-${i}`,
                    );
                    break;
                case 3:
                    fixture.db
                        .prepare(
                            "UPDATE compartments SET title = ?, end_message = start_message WHERE id = ?",
                        )
                        .run(`changed-${i}`, id);
                    break;
                case 4:
                    fixture.db
                        .prepare(
                            "UPDATE message_fts_rowid_map SET message_time_ms = ? WHERE message_ordinal = ?",
                        )
                        .run(i % 2 ? null : i * 100, id * 2);
                    break;
                case 5:
                    fixture.db
                        .prepare(
                            "UPDATE compartment_chunk_embeddings SET window_index = window_index + 1 WHERE id = ?",
                        )
                        .run(id);
                    break;
            }
            const from = Math.floor(random() * 8000);
            const date = i % 3 ? { from, to: from + Math.floor(random() * 2000) } : null;
            const query = Float32Array.from({ length: 8 }, () => random() - 0.5);
            const cutoff = Math.floor(random() * 250);
            const base = baseSearchPool(fixture.db, "session", "/project", date);
            const tip = await load(fixture.db, date);
            expect(tip).toEqual(base);
            expect(rank(tip, query, cutoff)).toEqual(rank(base, query, cutoff));
        }
    } finally {
        fixture.close();
        _resetCompartmentChunkSearchCacheForTests();
    }
});

scaleTest(
    "cold full rebuild returns every row across cooperative slices",
    async (slow) => {
        const count = slow ? 15000 : 128;
        const fixture = searchPoolFixture(count, slow ? 4096 : 64);
        try {
            const result = await measureSearchBlock(() => load(fixture.db));
            expect(result.value).toHaveLength(count);
            console.log(
                `search-pool cold: max=${result.maximum.toFixed(2)}ms cpu-at-max=${result.cpuMsAtMaximum.toFixed(2)}ms (${result.cpuSource}) total=${result.elapsed.toFixed(2)}ms`,
            );
            if (slow) expect(result.maximum).toBeLessThan(50);
        } finally {
            fixture.close();
            _resetCompartmentChunkSearchCacheForTests();
        }
    },
    30000,
);

slowOnlyTest("heartbeat CPU samples observe synchronous busy work", async () => {
    const measured = await measureSearchBlock(() => {
        let value = 1;
        for (let i = 0; i < 20_000_000; i++) value = (Math.imul(value, 1664525) + 1013904223) | 0;
        return value;
    }, "CPU counter calibration");
    expect(measured.value).not.toBe(0);
    expect(measured.totalCpuMs).toBeGreaterThan(1);
    expect(measured.maximumCpuMs).toBeGreaterThan(1);
    console.log(
        `heartbeat CPU calibration: source=${measured.cpuSource} total=${measured.totalCpuMs.toFixed(2)}ms max=${measured.maximumCpuMs.toFixed(2)}ms`,
    );
});

slowOnlyTest("heartbeat stops sampling when the measured operation ends", async () => {
    const measured = await measureSearchBlock(() => 4, "short measurement");
    const before = measured.outliers.slice();
    const started = performance.now();
    let value = 1;
    while (performance.now() - started < 60) value = (Math.imul(value, 1664525) + 1013904223) | 0;
    expect(Number.isInteger(value)).toBe(true);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(measured.outliers).toEqual(before);
});
