/// <reference types="bun-types" />

import { describe, expect, it } from "bun:test";
import { join } from "node:path";
import {
    getMessageSearchWorkerFallbacks,
    searchMessageHistoryOffThread,
} from "../../hooks/magic-context/auto-search-worker-client";
import { Database } from "../../shared/sqlite";
import { createTestTempDir } from "../../shared/test-temp-dir";
import { ensureMessagesIndexed } from "./message-index";
import { createUnifiedSearchDiagnostics, type UnifiedSearchOptions, unifiedSearch } from "./search";
import { initializeDatabase } from "./storage-db";

const SESSION = "ses-off-thread";

/** A session where the query's literal probes match very different shares of messages. */
function seed(db: Database): void {
    const messages = Array.from({ length: 400 }, (_, index) => ({
        ordinal: index + 1,
        id: `m-${index}`,
        role: index % 2 ? "assistant" : "user",
        parts: [
            {
                type: "text",
                text: [
                    index % 3 === 0 ? "cache_timeout" : "retry budget",
                    index % 41 === 0 ? "src/config.json" : "notes.md",
                    index % 7 === 0 ? "worker pool drains" : "queue backlog",
                    `step ${index}`,
                ].join(" "),
            },
        ],
    }));
    ensureMessagesIndexed(db, SESSION, () => messages);
}

function options(extra: Partial<UnifiedSearchOptions> = {}): UnifiedSearchOptions {
    return {
        sources: ["message"],
        limit: 25,
        embeddingEnabled: false,
        isEmbeddingRuntimeEnabled: () => false,
        explicitSearch: true,
        countRetrievals: false,
        measurementDisabled: true,
        ...extra,
    };
}

const QUERY = "where does cache_timeout in src/config.json reach the worker pool";

describe("message search off the serving thread", () => {
    it("returns the in-process results and ranking from a worker", async () => {
        const { dir: directory, cleanup } = createTestTempDir("mc-search-worker-");
        const db = new Database(join(directory, "context.db"));
        try {
            initializeDatabase(db);
            seed(db);
            for (const variant of [{}, { maxMessageOrdinal: 300 }]) {
                const inProcessDiagnostics = createUnifiedSearchDiagnostics();
                const inProcess = await unifiedSearch(
                    db,
                    SESSION,
                    "git:off-thread",
                    QUERY,
                    options({ ...variant, diagnostics: inProcessDiagnostics }),
                );
                let delegated = 0;
                const workerDiagnostics = createUnifiedSearchDiagnostics();
                const offThread = await unifiedSearch(
                    db,
                    SESSION,
                    "git:off-thread",
                    QUERY,
                    options({
                        ...variant,
                        diagnostics: workerDiagnostics,
                        searchMessageHistory: async (request) => {
                            const outcome = await searchMessageHistoryOffThread(db, request);
                            if (outcome) delegated += 1;
                            return outcome;
                        },
                    }),
                );
                expect(inProcess.length).toBeGreaterThan(3);
                expect(delegated).toBe(1);
                expect(offThread).toEqual(inProcess);
                expect(workerDiagnostics).toEqual(inProcessDiagnostics);
            }
        } finally {
            db.close();
            cleanup();
        }
    }, 60_000);

    it("runs no message FTS statement on the caller's connection when delegated", async () => {
        const { dir: directory, cleanup } = createTestTempDir("mc-search-worker-");
        const db = new Database(join(directory, "context.db"));
        try {
            initializeDatabase(db);
            seed(db);
            const statements: string[] = [];
            const prepare = db.prepare.bind(db);
            db.prepare = ((sql: string) => {
                statements.push(sql);
                return prepare(sql);
            }) as typeof db.prepare;
            const results = await unifiedSearch(
                db,
                SESSION,
                "git:off-thread",
                QUERY,
                options({
                    searchMessageHistory: (request) => searchMessageHistoryOffThread(db, request),
                }),
            );
            db.prepare = prepare;
            expect(results.length).toBeGreaterThan(3);
            expect(statements.filter((sql) => sql.includes("message_history_fts"))).toEqual([]);
        } finally {
            db.close();
            cleanup();
        }
    }, 60_000);

    it("falls back to the in-process lane, and counts it, when an accepted worker never answers", async () => {
        const { dir: directory, cleanup } = createTestTempDir("mc-search-worker-");
        const db = new Database(join(directory, "context.db"));
        const silent = new URL(
            "../../hooks/magic-context/message-search-accepting-silent-worker.fixture.ts",
            import.meta.url,
        );
        try {
            initializeDatabase(db);
            seed(db);
            const before = getMessageSearchWorkerFallbacks().get("no-result") ?? 0;
            let answered: unknown = "unset";
            const results = await unifiedSearch(
                db,
                SESSION,
                "git:off-thread",
                QUERY,
                options({
                    searchMessageHistory: async (request) => {
                        answered = await searchMessageHistoryOffThread(db, request, silent, {
                            resultMs: 300,
                        });
                        return answered as null;
                    },
                }),
            );
            expect(answered).toBeNull();
            expect(getMessageSearchWorkerFallbacks().get("no-result") ?? 0).toBe(before + 1);
            expect(results.length).toBeGreaterThan(3);
            expect(results).toEqual(
                await unifiedSearch(db, SESSION, "git:off-thread", QUERY, options()),
            );
        } finally {
            db.close();
            cleanup();
        }
    }, 30_000);

    it("runs the lane in process when no worker can open the store", async () => {
        const db = new Database(":memory:");
        try {
            initializeDatabase(db);
            seed(db);
            let asked = 0;
            const results = await unifiedSearch(
                db,
                SESSION,
                "git:off-thread",
                QUERY,
                options({
                    searchMessageHistory: (request) => {
                        asked += 1;
                        return searchMessageHistoryOffThread(db, request);
                    },
                }),
            );
            expect(asked).toBe(1);
            expect(results).toEqual(
                await unifiedSearch(db, SESSION, "git:off-thread", QUERY, options()),
            );
        } finally {
            db.close();
        }
    });
});
