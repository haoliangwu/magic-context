/// <reference types="bun-types" />

import { afterEach, describe, expect, mock, test } from "bun:test";
import { Database } from "../../../shared/sqlite";
import { closeQuietly } from "../../../shared/sqlite-helpers";
import { insertMemory } from "../memory";
import { runMigrations } from "../migrations";
import { initializeDatabase } from "../storage-db";
import { archiveExpiredMemories } from "./expire-memories";
import { acquireLeaseWithAcquisition } from "./lease";
import type { DreamerModuleRoute } from "./module-apply";
import { leaseKeyFor } from "./task-registry";

let db: Database | null = null;

afterEach(() => {
    if (db) closeQuietly(db);
    db = null;
});

describe("archiveExpiredMemories", () => {
    test("routes expiry using shared context ids without a mirror pull", async () => {
        db = new Database(":memory:");
        initializeDatabase(db);
        runMigrations(db);
        const project = "/repo/module-expiry";
        const now = Date.now();
        const memory = insertMemory(db, {
            projectPath: project,
            category: "KNOWN_ISSUES",
            content: "A module-owned TTL memory.",
            expiresAt: now - 1,
        });
        const call = mock(async () => {
            db!
                .prepare("UPDATE memories SET status = 'archived', metadata_json = ? WHERE id = ?")
                .run(JSON.stringify({ archive_reason: "expired" }), memory.id);
            return { result: { ok: true } };
        });
        const moduleRoute: DreamerModuleRoute = {
            moduleClient: { call },
            moduleSessionId: project,
            moduleProjectRoot: project,
            moduleCommandId: "curate-expiry",
        };
        const holderId = "module-expiry-holder";
        const leaseKey = leaseKeyFor("curate", project);
        const leaseAcquisition = acquireLeaseWithAcquisition(db, holderId, leaseKey);
        expect(leaseAcquisition).not.toBeNull();

        const archived = await archiveExpiredMemories({
            db,
            projectIdentity: project,
            holderId,
            leaseKey,
            leaseAcquisition: leaseAcquisition!,
            now,
            moduleRoute,
        });

        expect(archived).toBe(1);
        expect(call).toHaveBeenCalledWith({
            sessionId: project,
            projectRoot: project,
            method: "ctx_memory",
            body: {
                name: "ctx_memory",
                arguments: {
                    action: "archive",
                    memory_project: project,
                    ids: [memory.id],
                    reason: "expired",
                    command_id: "curate-expiry:expire:0",
                },
            },
        });
        expect(
            db.prepare("SELECT status, metadata_json FROM memories WHERE id = ?").get(memory.id),
        ).toEqual({
            status: "archived",
            metadata_json: JSON.stringify({ archive_reason: "expired" }),
        });
        expect(db.prepare("SELECT COUNT(*) AS count FROM memory_mutation_log").get()).toEqual({
            count: 0,
        });
    });
});
