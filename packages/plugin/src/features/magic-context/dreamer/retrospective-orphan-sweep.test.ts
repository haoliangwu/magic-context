/// <reference types="bun-types" />

import { afterEach, describe, expect, mock, test } from "bun:test";

import { Database } from "../../../shared/sqlite";
import { closeQuietly } from "../../../shared/sqlite-helpers";
import {
    CLASSIFY_CHILD_TITLE,
    COMPRESS_CUES_CHILD_TITLE,
    CURATE_CHILD_TITLE,
    HISTORIAN_CHILD_TITLE,
    historianOrphanStaleMs,
    MAINTAIN_DOCS_CHILD_TITLE,
    MAP_MEMORIES_CHILD_TITLE,
    MEMORY_MIGRATION_CHILD_TITLE,
    REFRESH_PRIMERS_CHILD_TITLE,
    RETROSPECTIVE_CHILD_TITLE,
    retrospectiveOrphanStaleMs,
    SMART_NOTE_COMPILE_CHILD_TITLE_PREFIX,
    SMART_NOTE_CONFIRM_CHILD_TITLE_PREFIX,
    sweepOrphanedRetrospectiveChildren,
    USER_MEMORIES_CHILD_TITLE,
    VERIFY_CHILD_TITLE,
} from "./retrospective-orphan-sweep";

let db: Database | null = null;
afterEach(() => {
    if (db) closeQuietly(db);
    db = null;
});

function makeOpencodeDb(): Database {
    const database = new Database(":memory:");
    database.exec(`
        CREATE TABLE session (
            id TEXT PRIMARY KEY,
            title TEXT,
            directory TEXT,
            time_created INTEGER,
            time_archived INTEGER
        );
    `);
    return database;
}

function insert(
    database: Database,
    id: string,
    title: string,
    dir: string,
    created: number,
    archived: number | null = null,
) {
    database
        .prepare(
            "INSERT INTO session (id, title, directory, time_created, time_archived) VALUES (?, ?, ?, ?, ?)",
        )
        .run(id, title, dir, created, archived);
}

describe("retrospectiveOrphanStaleMs", () => {
    test("is at least 60min and adds detached-writer grace after timeout×3", () => {
        expect(retrospectiveOrphanStaleMs(20)).toBe(75 * 60_000);
        expect(retrospectiveOrphanStaleMs(30)).toBe(105 * 60_000);
        expect(retrospectiveOrphanStaleMs([10, 45, undefined])).toBe(150 * 60_000);
        expect(retrospectiveOrphanStaleMs(undefined)).toBe(75 * 60_000);
    });
});

describe("historianOrphanStaleMs", () => {
    test("covers every outer, model-suggestion, and fallback attempt plus grace", () => {
        const timeoutMs = 10 * 60_000;
        const fallbackModelCount = 2;
        const fullAttemptBudget = timeoutMs * 3 * 2 * (fallbackModelCount + 1);

        expect(historianOrphanStaleMs(timeoutMs, fallbackModelCount)).toBeGreaterThan(
            fullAttemptBudget,
        );
    });
});

describe("sweepOrphanedRetrospectiveChildren", () => {
    const DIR = "/repo/project";
    const now = 10_000_000;
    const staleMs = 60 * 60_000;

    function deleteClient() {
        const deleted: string[] = [];
        const client = {
            session: {
                delete: mock(async ({ path }: { path: { id: string } }) => {
                    deleted.push(path.id);
                    return {};
                }),
            },
        } as never;
        return { client, deleted };
    }

    test("deletes old privacy-sensitive children in this directory", async () => {
        db = makeOpencodeDb();
        // old orphans in this dir → swept
        insert(db, "old-historian", HISTORIAN_CHILD_TITLE, DIR, now - staleMs - 8);
        insert(db, "old-user-memories", USER_MEMORIES_CHILD_TITLE, DIR, now - staleMs - 7);
        insert(db, "old", RETROSPECTIVE_CHILD_TITLE, DIR, now - staleMs - 6);
        insert(db, "old-curate", CURATE_CHILD_TITLE, DIR, now - staleMs - 5);
        insert(db, "old-docs", MAINTAIN_DOCS_CHILD_TITLE, DIR, now - staleMs - 4);
        insert(db, "old-refresh", REFRESH_PRIMERS_CHILD_TITLE, DIR, now - staleMs - 3);
        insert(
            db,
            "old-compile",
            `${SMART_NOTE_COMPILE_CHILD_TITLE_PREFIX}7`,
            DIR,
            now - staleMs - 2,
        );
        insert(
            db,
            "old-confirm",
            `${SMART_NOTE_CONFIRM_CHILD_TITLE_PREFIX}7`,
            DIR,
            now - staleMs - 1,
        );
        // recent children (live or still draining detached writes) → NOT swept
        insert(db, "fresh", RETROSPECTIVE_CHILD_TITLE, DIR, now - 1000);
        insert(db, "fresh-historian", HISTORIAN_CHILD_TITLE, DIR, now - 1000);
        insert(db, "old-migration", MEMORY_MIGRATION_CHILD_TITLE, DIR, now - staleMs - 14);
        insert(db, "old-map", MAP_MEMORIES_CHILD_TITLE, DIR, now - staleMs - 12);
        insert(db, "old-verify", VERIFY_CHILD_TITLE, DIR, now - staleMs - 11);
        insert(db, "old-classify", CLASSIFY_CHILD_TITLE, DIR, now - staleMs - 10);
        insert(db, "old-cues", COMPRESS_CUES_CHILD_TITLE, DIR, now - staleMs - 9);
        // old but a different title → NOT swept
        insert(db, "other-title", "magic-context-dream-not-covered", DIR, now - staleMs - 1);
        // old retrospective but ANOTHER directory → NOT swept
        insert(db, "other-dir", RETROSPECTIVE_CHILD_TITLE, "/repo/elsewhere", now - staleMs - 1);

        const { client, deleted } = deleteClient();
        const count = await sweepOrphanedRetrospectiveChildren({
            opencodeDb: db,
            client,
            sessionDirectory: DIR,
            staleMs,
            now,
        });

        expect(deleted).toEqual([
            "old-migration",
            "old-map",
            "old-verify",
            "old-classify",
            "old-cues",
            "old-historian",
            "old-user-memories",
            "old",
            "old-curate",
            "old-docs",
            "old-refresh",
            "old-compile",
            "old-confirm",
        ]);
        expect(count).toBe(13);
    });

    test("sweeps all four memory-snapshot task titles and rejects an unknown title", async () => {
        db = makeOpencodeDb();
        const coveredTitles = [
            MAP_MEMORIES_CHILD_TITLE,
            VERIFY_CHILD_TITLE,
            CLASSIFY_CHILD_TITLE,
            COMPRESS_CUES_CHILD_TITLE,
        ];
        for (const [index, title] of coveredTitles.entries()) {
            insert(db, `covered-${index}`, title, DIR, now - staleMs - index - 1);
        }
        insert(db, "not-covered", "magic-context-dream-unrelated", DIR, now - staleMs - 10);
        const { client, deleted } = deleteClient();

        const count = await sweepOrphanedRetrospectiveChildren({
            opencodeDb: db,
            client,
            sessionDirectory: DIR,
            staleMs,
            now,
        });

        expect(count).toBe(4);
        expect(deleted).toEqual(["covered-3", "covered-2", "covered-1", "covered-0"]);
        expect(deleted).not.toContain("not-covered");
    });

    test("keeps a recent historian child and sweeps it after the full attempt budget", async () => {
        db = makeOpencodeDb();
        const configuredStaleMs = historianOrphanStaleMs(10 * 60_000, 2);
        const historianNow = configuredStaleMs + 1_000_000;
        insert(
            db,
            "historian-still-draining",
            HISTORIAN_CHILD_TITLE,
            DIR,
            historianNow - configuredStaleMs + 1,
        );
        insert(
            db,
            "historian-budget-expired",
            HISTORIAN_CHILD_TITLE,
            DIR,
            historianNow - configuredStaleMs - 1,
        );
        const { client, deleted } = deleteClient();

        const count = await sweepOrphanedRetrospectiveChildren({
            opencodeDb: db,
            client,
            sessionDirectory: DIR,
            staleMs: configuredStaleMs,
            now: historianNow,
        });

        expect(count).toBe(1);
        expect(deleted).toEqual(["historian-budget-expired"]);
    });

    test("keep_subagents sweeps an unsettled privacy child but preserves settled children", async () => {
        db = makeOpencodeDb();
        insert(db, "settled-historian", HISTORIAN_CHILD_TITLE, DIR, now - staleMs - 1);
        insert(db, "settled-migration", MEMORY_MIGRATION_CHILD_TITLE, DIR, now - staleMs - 2);
        insert(db, "settled-private", RETROSPECTIVE_CHILD_TITLE, DIR, now - staleMs - 3);
        insert(db, "unsettled-private", CURATE_CHILD_TITLE, DIR, now - staleMs - 4, now - staleMs);
        const { client, deleted } = deleteClient();

        const count = await sweepOrphanedRetrospectiveChildren({
            opencodeDb: db,
            client,
            sessionDirectory: DIR,
            staleMs: { privacy: staleMs, historian: staleMs },
            now,
            keepSubagents: true,
        });

        expect(count).toBe(1);
        expect(deleted).toEqual(["unsettled-private"]);
    });

    test("treats a delete error (404 / already removed) as success", async () => {
        db = makeOpencodeDb();
        insert(db, "gone", RETROSPECTIVE_CHILD_TITLE, DIR, now - staleMs - 1);
        const client = {
            session: {
                delete: mock(async () => {
                    throw new Error("404 not found");
                }),
            },
        } as never;

        const count = await sweepOrphanedRetrospectiveChildren({
            opencodeDb: db,
            client,
            sessionDirectory: DIR,
            staleMs,
            now,
        });
        expect(count).toBe(1);
    });

    test("null db → no-op", async () => {
        const { client } = deleteClient();
        const count = await sweepOrphanedRetrospectiveChildren({
            opencodeDb: null,
            client,
            sessionDirectory: DIR,
            staleMs,
            now,
        });
        expect(count).toBe(0);
    });

    test("missing session table fails open (no throw)", async () => {
        db = new Database(":memory:"); // no `session` table
        const { client } = deleteClient();
        const count = await sweepOrphanedRetrospectiveChildren({
            opencodeDb: db,
            client,
            sessionDirectory: DIR,
            staleMs,
            now,
        });
        expect(count).toBe(0);
    });
});
