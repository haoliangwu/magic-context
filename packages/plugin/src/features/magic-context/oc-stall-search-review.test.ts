/// <reference types="bun-types" />

import { expect, test } from "bun:test";
import { join } from "node:path";
import { searchMessageHistoryOffThread } from "../../hooks/magic-context/auto-search-worker-client";
import { Database } from "../../shared/sqlite";
import { createTestTempDir } from "../../shared/test-temp-dir";
import { ensureMessagesIndexed } from "./message-index";
import {
    type MessageHistorySearchRequest,
    type UnifiedSearchOptions,
    unifiedSearch,
} from "./search";
import { initializeDatabase } from "./storage-db";

const SESSION = "ses-stall-search-review";
const ENTRY = new URL(
    "../../hooks/magic-context/oc-stall-search-review.fixture.ts",
    import.meta.url,
);
const OPTIONS: UnifiedSearchOptions = {
    sources: ["message"],
    limit: 10,
    embeddingEnabled: false,
    isEmbeddingRuntimeEnabled: () => false,
    explicitSearch: true,
    countRetrievals: false,
    measurementDisabled: true,
};

test("silent worker: the message lane must resolve to fallback within a bounded wait", async () => {
    const { dir, cleanup } = createTestTempDir("mc-stall-search-review-");
    const db = new Database(join(dir, "context.db"));
    const request = {
        sessionId: SESSION,
        query: "review-no-reply",
        limit: 10,
    } as MessageHistorySearchRequest;
    let pending: ReturnType<typeof searchMessageHistoryOffThread> | undefined;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
        initializeDatabase(db);
        pending = searchMessageHistoryOffThread(db, request, ENTRY);
        const outcome = await Promise.race([
            pending.then(() => "settled"),
            new Promise<string>((resolve) => {
                timeout = setTimeout(() => resolve("still pending"), 500);
            }),
        ]);
        expect(outcome).toBe("settled");
    } finally {
        clearTimeout(timeout);
        // Await the fixture's finite exit even when the expected assertion fails.
        await pending;
        db.close();
        cleanup();
    }
}, 10_000);

test("silent worker: a reported worker error falls back with identical results and order", async () => {
    const { dir, cleanup } = createTestTempDir("mc-stall-search-review-");
    const db = new Database(join(dir, "context.db"));
    try {
        initializeDatabase(db);
        ensureMessagesIndexed(db, SESSION, () =>
            Array.from({ length: 12 }, (_, index) => ({
                id: `m-${index}`,
                ordinal: index + 1,
                role: "user",
                parts: [{ type: "text", text: `review-error searchable fixture ${index}` }],
            })),
        );
        const expected = await unifiedSearch(db, SESSION, "git:review", "review-error", OPTIONS);
        expect(expected.length).toBeGreaterThan(0);
        let fallback = false;
        const actual = await unifiedSearch(db, SESSION, "git:review", "review-error", {
            ...OPTIONS,
            searchMessageHistory: async (request) => {
                const outcome = await searchMessageHistoryOffThread(db, request, ENTRY);
                fallback = outcome === null;
                return outcome;
            },
        });
        expect(fallback).toBe(true);
        expect(actual).toEqual(expected);
    } finally {
        db.close();
        cleanup();
    }
}, 10_000);

test("a fresh message worker observes a committed index update", async () => {
    const { dir, cleanup } = createTestTempDir("mc-stall-search-review-");
    const db = new Database(join(dir, "context.db"));
    try {
        initializeDatabase(db);
        const indexed = [
            {
                id: "m-1",
                ordinal: 1,
                role: "user",
                parts: [{ type: "text", text: "before-needle" }],
            },
        ];
        ensureMessagesIndexed(db, SESSION, () => indexed);
        const delegated = {
            ...OPTIONS,
            searchMessageHistory: (request: MessageHistorySearchRequest) =>
                searchMessageHistoryOffThread(db, request),
        };
        const before = await unifiedSearch(db, SESSION, "git:review", "after-needle", delegated);
        indexed.push({
            id: "m-2",
            ordinal: 2,
            role: "user",
            parts: [{ type: "text", text: "after-needle" }],
        });
        ensureMessagesIndexed(db, SESSION, () => indexed);
        const expected = await unifiedSearch(db, SESSION, "git:review", "after-needle", OPTIONS);
        const after = await unifiedSearch(db, SESSION, "git:review", "after-needle", delegated);
        expect(expected.length).toBeGreaterThan(before.length);
        expect(after).toEqual(expected);
    } finally {
        db.close();
        cleanup();
    }
}, 30_000);
