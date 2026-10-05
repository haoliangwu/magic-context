import { describe, expect, it } from "bun:test";
import { OPENCODE2_RELABEL_STATE_KEY } from "@magic-context/core/features/magic-context/opencode2-relabel";
import {
    initializeDatabase,
    runMigrations,
} from "@magic-context/core/features/magic-context/storage";
import { Database } from "@magic-context/core/shared/sqlite";
import { reportUnresolvedHarnessRelabel } from "./doctor-harness-relabel";

function contextDatabase(): Database {
    const db = new Database(":memory:");
    initializeDatabase(db);
    runMigrations(db);
    return db;
}

function recordUnresolved(db: Database, sessionIds: string[]): void {
    db.prepare(
        `INSERT INTO schema_migrations_meta (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    ).run(
        OPENCODE2_RELABEL_STATE_KEY,
        JSON.stringify({
            reason: "store_not_found",
            lookedFor: "/home/qoole/.local/share/opencode/opencode.db",
            sessionIds,
            recordedAt: 1_700_000_000_000,
        }),
    );
}

describe("doctor: unverified OpenCode harness labels", () => {
    it("stays silent when the repair had a store to read", () => {
        const db = contextDatabase();
        try {
            const warnings: string[] = [];
            expect(
                reportUnresolvedHarnessRelabel({
                    db,
                    warn: (message) => warnings.push(message),
                    detail: (message) => warnings.push(message),
                }),
            ).toBe(false);
            expect(warnings).toEqual([]);
        } finally {
            db.close();
        }
    });

    it("names the affected sessions and where the store was looked for", () => {
        const db = contextDatabase();
        try {
            recordUnresolved(db, ["ses-a", "ses-b"]);
            const warnings: string[] = [];
            const details: string[] = [];
            expect(
                reportUnresolvedHarnessRelabel({
                    db,
                    warn: (message) => warnings.push(message),
                    detail: (message) => details.push(message),
                }),
            ).toBe(true);
            expect(warnings).toHaveLength(1);
            expect(warnings[0]).toContain("2 session(s)");
            expect(warnings[0]).toContain("store_not_found");
            expect(warnings[0]).toContain("/home/qoole/.local/share/opencode/opencode.db");
            expect(warnings[0]).toContain("OPENCODE_DB");
            expect(details).toEqual(["  ses-a", "  ses-b"]);
        } finally {
            db.close();
        }
    });

    it("caps a long session list and says how many were left out", () => {
        const db = contextDatabase();
        try {
            recordUnresolved(
                db,
                Array.from({ length: 25 }, (_, index) => `ses-${index}`),
            );
            const details: string[] = [];
            reportUnresolvedHarnessRelabel({
                db,
                warn: () => undefined,
                detail: (message) => details.push(message),
            });
            expect(details).toHaveLength(21);
            expect(details.at(-1)).toBe("  …and 5 more");
        } finally {
            db.close();
        }
    });
});
