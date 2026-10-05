import { afterEach, describe, expect, it } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestTempDirFromPath } from "../../shared/test-temp-dir";
import { closeDatabase, openDatabase } from "./storage";
import {
    listEmbeddingMeasurements,
    normalizedQueryHash,
    recordEmbeddingMeasurement,
} from "./storage-embedding-measurements";

describe("embedding measurement corpus", () => {
    const dirs: string[] = [];
    const original = process.env.XDG_DATA_HOME;

    afterEach(() => {
        closeDatabase();
        if (original === undefined) delete process.env.XDG_DATA_HOME;
        else process.env.XDG_DATA_HOME = original;
        for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
    });

    it("stores hashed, bounded rank lists once per query cohort", () => {
        const dir = createTestTempDirFromPath(join(tmpdir(), "embedding-measurements-"));
        dirs.push(dir);
        process.env.XDG_DATA_HOME = dir;
        const db = openDatabase();
        const input = {
            sessionId: "ses-measure",
            projectPath: "/repo",
            queryText: "  Queue   backpressure ",
            cohortKey: "fp-a:0|fp-b:0",
            primaryResultIds: Array.from({ length: 12 }, (_, index) => `p:${index}`),
            shadowResultIds: ["s:1"],
            primaryLatencyMs: 10,
            shadowLatencyMs: 20,
            primaryFailed: false,
            shadowFailed: false,
            primaryModelId: "local-id",
            shadowModelId: "synapse-id",
            primaryFingerprint: "",
            shadowFingerprint: "fp-b",
            primaryEpoch: 0,
            shadowEpoch: 0,
            corpusHash: "corpus",
            coverage: { primary: 12, shadow: 1 },
        } as const;

        expect(recordEmbeddingMeasurement(db, input)).toBe(true);
        expect(recordEmbeddingMeasurement(db, input)).toBe(false);
        const rows = listEmbeddingMeasurements(db, "ses-measure");
        expect(rows).toHaveLength(1);
        expect(rows[0].query_text_hash).toBe(normalizedQueryHash(input.queryText));
        expect(JSON.parse(rows[0].primary_result_ids_json)).toHaveLength(10);
        expect(rows[0].query_text_hash).not.toContain(input.queryText);
    });

    it("bounds a session's corpus rows, keeping the newest when the cap is exceeded", () => {
        const dir = createTestTempDirFromPath(join(tmpdir(), "embedding-measurements-cap-"));
        dirs.push(dir);
        process.env.XDG_DATA_HOME = dir;
        const db = openDatabase();
        // The cap is injectable so the eviction boundary can be exercised at a
        // small scale instead of the production 2000-row cap. The invariant
        // under test — "keeps the newest rows when the cap is exceeded" — is
        // scale-independent, so a small cap proves it in milliseconds rather
        // than ~7s of disk-backed inserts (which previously timed out on
        // slower hardware against bun's default 5s per-test budget).
        const cap = 25;
        const overflow = 5;
        const total = cap + overflow;
        for (let i = 0; i < total; i++) {
            recordEmbeddingMeasurement(
                db,
                {
                    sessionId: "ses-cap",
                    projectPath: "/repo",
                    // Unique query text per row: dedup is on (query hash, cohort), so
                    // distinct queries simulate the cohort-transition growth.
                    queryText: `query ${i}`,
                    cohortKey: "fp-a:0|fp-b:0",
                    primaryResultIds: [],
                    shadowResultIds: [],
                    primaryLatencyMs: 1,
                    shadowLatencyMs: 1,
                    primaryFailed: false,
                    shadowFailed: false,
                    primaryModelId: "local-id",
                    shadowModelId: "synapse-id",
                    primaryFingerprint: "",
                    shadowFingerprint: "fp-b",
                    primaryEpoch: 0,
                    shadowEpoch: 0,
                    corpusHash: `corpus-${i}`,
                    coverage: {},
                },
                cap,
            );
        }

        const rows = listEmbeddingMeasurements(db, "ses-cap");
        expect(rows).toHaveLength(cap);
        // The oldest `overflow` rows were pruned; the newest cap rows survive.
        expect(rows[0].query_text_hash).toBe(normalizedQueryHash(`query ${overflow}`));
        expect(rows[rows.length - 1].query_text_hash).toBe(
            normalizedQueryHash(`query ${total - 1}`),
        );
    });
});
