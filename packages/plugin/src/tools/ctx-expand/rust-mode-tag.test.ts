/// <reference types="bun-types" />

import { describe, expect, it } from "bun:test";
import { runMigrations } from "../../features/magic-context/migrations";
import { initializeDatabase } from "../../features/magic-context/storage-db";
import { Database } from "../../shared/sqlite";
import {
    RUST_ERA_REPLY,
    SESSION_ID,
    seedTsEraTagsThenRustHistory,
    TS_ERA_TEXT,
    TS_ERA_TOOL_OUTPUT,
} from "./rust-mode-tag.test-support";
import { CTX_EXPAND_RUST_TAG_REFUSAL, createCtxExpandTools } from "./tools";

function freshDb(): Database {
    const db = new Database(":memory:");
    initializeDatabase(db);
    runMigrations(db);
    return db;
}

describe("ctx_expand(tag) on a session that moved from TypeScript to Rust transform mode", () => {
    it("refuses the lookup instead of returning the TypeScript-era item with the same number", async () => {
        const db = freshDb();
        const cleanup = seedTsEraTagsThenRustHistory(db);
        try {
            const expand = createCtxExpandTools({ db, transformMode: "rust" }).ctx_expand;
            const ctx = { sessionID: SESSION_ID } as never;
            for (const tag of [75386, "[dropped §75394§]", "§75386§"]) {
                const reply = await expand.execute({ tag }, ctx);
                expect(reply).toBe(CTX_EXPAND_RUST_TAG_REFUSAL);
                expect(reply).not.toContain("callgraph trio");
                expect(reply).not.toContain("Saved session note");
            }
            // Expanding by message still serves host history in Rust mode.
            expect(await expand.execute({ message: 3 }, ctx)).toContain(RUST_ERA_REPLY);
        } finally {
            cleanup();
            db.close();
        }
    });

    it("keeps the TypeScript transform's tag lookup unchanged", async () => {
        const db = freshDb();
        const cleanup = seedTsEraTagsThenRustHistory(db);
        try {
            const ctx = { sessionID: SESSION_ID } as never;
            for (const deps of [{ db }, { db, transformMode: "ts" as const }]) {
                const expand = createCtxExpandTools(deps).ctx_expand;
                expect(await expand.execute({ tag: 75386 }, ctx)).toContain(TS_ERA_TEXT);
                expect(await expand.execute({ tag: "[dropped §75394§]" }, ctx)).toContain(
                    TS_ERA_TOOL_OUTPUT,
                );
            }
        } finally {
            cleanup();
            db.close();
        }
    });
});
