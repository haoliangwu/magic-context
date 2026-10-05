import { expect, it, spyOn } from "bun:test";
import { Database } from "../../shared/sqlite";
import { closeQuietly } from "../../shared/sqlite-helpers";
import { runMigrations } from "./migrations";
import { unifiedSearch } from "./search";
import { initializeDatabase } from "./storage-db";

it("does not scan vector lanes when a late embedding ignores cancellation", async () => {
    const db = new Database(":memory:");
    initializeDatabase(db);
    runMigrations(db);
    const prepare = db.prepare.bind(db);
    const sql: string[] = [];
    const spy = spyOn(db, "prepare").mockImplementation((query: string) => {
        sql.push(query);
        return prepare(query);
    });
    const controller = new AbortController();
    let release: ((vector: Float32Array) => void) | undefined;
    const embedding = new Promise<Float32Array>((resolve) => {
        release = resolve;
    });
    try {
        const pending = unifiedSearch(db, "cancelled", "project", "cache question", {
            memoryEnabled: false,
            embeddingEnabled: true,
            sources: ["message"],
            embedQuery: () => embedding,
            isEmbeddingRuntimeEnabled: () => true,
            signal: controller.signal,
            chunkModelIdOverride: "test",
            countRetrievals: false,
            measurementDisabled: true,
        });
        await Promise.resolve();
        sql.length = 0;
        controller.abort();
        release?.(new Float32Array([1, 0]));
        expect(await pending).toEqual([]);
        expect(sql).toEqual([]);
    } finally {
        release?.(new Float32Array([1, 0]));
        spy.mockRestore();
        closeQuietly(db);
    }
});
