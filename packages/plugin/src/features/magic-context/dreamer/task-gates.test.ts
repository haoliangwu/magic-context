/// <reference types="bun-types" />

import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "../../../shared/sqlite";
import { closeQuietly } from "../../../shared/sqlite-helpers";
import {
    getMemoriesByProject,
    getUnclassifiedMemoryIds,
    insertMemory,
    recordMemoryVerifications,
    setMemoryClassification,
} from "../memory";
import { runMigrations } from "../migrations";
import { initializeDatabase } from "../storage-db";
import { evaluateTaskGate, getDreamTaskBacklog } from "./task-gates";
import { formatDreamTaskBacklogs, processedDreamTaskItems } from "./task-registry";

let db: Database | null = null;

afterEach(() => {
    if (db) closeQuietly(db);
    db = null;
});

function freshDb(): Database {
    const database = new Database(":memory:");
    initializeDatabase(database);
    runMigrations(database);
    return database;
}

describe("dream task backlog probes", () => {
    test("map and classify probes match seeded candidate counts", () => {
        db = freshDb();
        const projectIdentity = "/repo/project";
        const first = insertMemory(db, {
            projectPath: projectIdentity,
            category: "PROJECT_RULES",
            content: "Keep the first memory mapped.",
        });
        insertMemory(db, {
            projectPath: projectIdentity,
            category: "ARCHITECTURE",
            content: "The second memory still needs mapping and classification.",
        });
        recordMemoryVerifications(db, first.id, ["src/first.ts"], Date.now());

        expect(getDreamTaskBacklog(db, projectIdentity, "map-memories")).toEqual({
            pending: 1,
            total: 2,
        });
        expect(getDreamTaskBacklog(db, projectIdentity, "classify-memories")).toEqual({
            pending: 2,
            total: 2,
        });

        setMemoryClassification(db, first.id, { importance: 80 });
        expect(getDreamTaskBacklog(db, projectIdentity, "classify-memories")).toEqual({
            pending: 1,
            total: 2,
        });
    });

    test("uses the executor's live pool for reporter backlog counts", () => {
        db = freshDb();
        const projectIdentity = "/repo/expiry-backlog";
        const now = Date.now();

        const classifiedLive = insertMemory(db, {
            projectPath: projectIdentity,
            category: "ARCHITECTURE",
            content: "A classified live memory.",
        });
        setMemoryClassification(db, classifiedLive.id, { importance: 70 });
        for (let index = 0; index < 2; index += 1) {
            insertMemory(db, {
                projectPath: projectIdentity,
                category: "PROJECT_RULES",
                content: `Unclassified live memory ${index}.`,
            });
        }
        const expiredActive = [];
        for (let index = 0; index < 3; index += 1) {
            expiredActive.push(
                insertMemory(db, {
                    projectPath: projectIdentity,
                    category: "KNOWN_ISSUES",
                    content: `Expired active memory ${index}.`,
                    expiresAt: now - 1,
                }),
            );
        }
        recordMemoryVerifications(db, classifiedLive.id, ["src/live.ts"], 0);
        recordMemoryVerifications(db, expiredActive[0]!.id, ["src/expired.ts"], 0);

        const sidebarSqlCount = (
            db
                .prepare(
                    `SELECT COUNT(*) AS count FROM memories
                      WHERE project_path = ?
                        AND status IN ('active','permanent')
                        AND classified_at IS NULL`,
                )
                .get(projectIdentity) as { count: number }
        ).count;
        const liveIds = getMemoriesByProject(db, projectIdentity).map((memory) => memory.id);
        const executorCandidates = getUnclassifiedMemoryIds(db, liveIds);
        const expiredActiveCount = (
            db
                .prepare(
                    `SELECT COUNT(*) AS count FROM memories
                      WHERE project_path = ?
                        AND status = 'active'
                        AND expires_at IS NOT NULL
                        AND expires_at <= ?`,
                )
                .get(projectIdentity, now) as { count: number }
        ).count;

        expect(sidebarSqlCount).toBe(5);
        expect(expiredActiveCount).toBe(3);
        expect(executorCandidates).toHaveLength(2);
        expect(getDreamTaskBacklog(db, projectIdentity, "classify-memories")).toEqual({
            pending: executorCandidates.length,
            total: 3,
        });
        expect(getDreamTaskBacklog(db, projectIdentity, "map-memories")).toEqual({
            pending: 2,
            total: 3,
        });
        expect(getDreamTaskBacklog(db, projectIdentity, "verify")).toEqual({
            pending: 1,
            total: 1,
        });
        expect(getDreamTaskBacklog(db, projectIdentity, "verify-broad")).toEqual({
            pending: 1,
            total: 1,
        });
        const curateBacklog = getDreamTaskBacklog(db, projectIdentity, "curate");
        expect(curateBacklog).toEqual({
            pending: 2,
            total: 2,
            category: "PROJECT_RULES",
        });
        expect(formatDreamTaskBacklogs({ curate: curateBacklog }, ["curate"])).toBe(
            "- curate: PROJECT_RULES (2)",
        );
        expect(getDreamTaskBacklog(db, projectIdentity, "compress-cues")).toEqual({
            pending: 3,
            total: 3,
        });
    });

    test("verify probe counts only mapped memories that are still unverified", () => {
        db = freshDb();
        const projectIdentity = "/repo/project";
        const pending = insertMemory(db, {
            projectPath: projectIdentity,
            category: "PROJECT_RULES",
            content: "This mapped memory still needs verification.",
        });
        const verified = insertMemory(db, {
            projectPath: projectIdentity,
            category: "ARCHITECTURE",
            content: "This mapped memory has already been verified.",
        });
        recordMemoryVerifications(db, pending.id, ["src/pending.ts"], Date.now());
        recordMemoryVerifications(db, verified.id, ["src/verified.ts"], Date.now());
        db.prepare("UPDATE memory_verifications SET verified_at = ? WHERE memory_id = ?").run(
            0,
            pending.id,
        );

        expect(getDreamTaskBacklog(db, projectIdentity, "verify")).toEqual({
            pending: 1,
            total: 2,
        });
    });

    test("processed count is the start-to-end backlog reduction", () => {
        expect(processedDreamTaskItems(17, 5)).toBe(12);
        expect(processedDreamTaskItems(5, 7)).toBe(0);
    });
});

describe("evaluateTaskGate", () => {
    test("classify-memories runs when active memories exist", () => {
        db = freshDb();
        const projectIdentity = "/repo/project";
        expect(
            evaluateTaskGate("classify-memories", {
                db,
                projectIdentity,
                lastRunAt: null,
                promotionThreshold: 3,
            }),
        ).toBe(false);

        insertMemory(db, {
            projectPath: projectIdentity,
            category: "PROJECT_RULES",
            content: "Use Bun for package scripts in this repo.",
        });

        expect(
            evaluateTaskGate("classify-memories", {
                db,
                projectIdentity,
                lastRunAt: Date.now(),
                promotionThreshold: 3,
            }),
        ).toBe(true);
    });

    test("only curate opens the memory lease for an expired-only pool", () => {
        db = freshDb();
        const projectIdentity = "/repo/expired-only";
        insertMemory(db, {
            projectPath: projectIdentity,
            category: "KNOWN_ISSUES",
            content: "An expired legacy issue needs a lifecycle transition, not task work.",
            expiresAt: Date.now() - 1,
        });
        const context = {
            db,
            projectIdentity,
            lastRunAt: null,
            promotionThreshold: 3,
        };

        expect(getDreamTaskBacklog(db, projectIdentity, "classify-memories")).toEqual({
            pending: 0,
            total: 0,
        });
        expect(evaluateTaskGate("map-memories", context)).toBe(false);
        expect(evaluateTaskGate("verify", context)).toBe(false);
        expect(evaluateTaskGate("verify-broad", context)).toBe(false);
        expect(evaluateTaskGate("compress-cues", context)).toBe(false);
        expect(evaluateTaskGate("classify-memories", context)).toBe(false);
        expect(evaluateTaskGate("curate", context)).toBe(true);
    });

    test("retrospective gates on the CONTENT watermark, not lastRunAt", () => {
        db = freshDb();
        const projectIdentity = "/repo/project";
        db.prepare(
            "INSERT INTO session_projects (session_id, harness, project_path, updated_at) VALUES (?, ?, ?, ?)",
        ).run("s1", "opencode", projectIdentity, 200);

        // Never scanned → runs.
        expect(
            evaluateTaskGate("retrospective", {
                db,
                projectIdentity,
                lastRunAt: null,
                retrospectiveWatermarkMs: null,
                promotionThreshold: 3,
            }),
        ).toBe(true);
        // Session newer than watermark → runs (even if lastRunAt is newer — the
        // session was updated mid-run, so its content hasn't been scanned).
        expect(
            evaluateTaskGate("retrospective", {
                db,
                projectIdentity,
                lastRunAt: 9999,
                retrospectiveWatermarkMs: 100,
                promotionThreshold: 3,
            }),
        ).toBe(true);
        // Watermark at/after the session update → nothing new → skip.
        expect(
            evaluateTaskGate("retrospective", {
                db,
                projectIdentity,
                lastRunAt: null,
                retrospectiveWatermarkMs: 300,
                promotionThreshold: 3,
            }),
        ).toBe(false);
    });
});
