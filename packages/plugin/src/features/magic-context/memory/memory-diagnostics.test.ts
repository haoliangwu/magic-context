import { describe, expect, test } from "bun:test";
import { Database } from "../../../shared/sqlite";
import { closeQuietly } from "../../../shared/sqlite-helpers";
import { runMigrations } from "../migrations";
import { initializeDatabase } from "../storage-db";
import { getActiveMemoryImportanceHistogram } from "./memory-diagnostics";
import { insertMemory, updateMemoryStatus } from "./storage-memory";

describe("active memory importance histogram", () => {
    test("discriminates a classified spread from an unclassified midpoint pile-up", () => {
        const db = new Database(":memory:");
        try {
            initializeDatabase(db);
            runMigrations(db);
            const projectPath = "git:histogram";
            const rows = [5, 25, 50, 65, 100].map((importance, index) =>
                insertMemory(db, {
                    projectPath,
                    category: "CONSTRAINTS",
                    content: `memory-${index}`,
                    importance,
                }),
            );
            const archived = insertMemory(db, {
                projectPath,
                category: "CONSTRAINTS",
                content: "archived-outlier",
                importance: 100,
            });
            updateMemoryStatus(db, archived.id, "archived");
            db.prepare("UPDATE memories SET classified_at = 123 WHERE id IN (?, ?, ?, ?)").run(
                rows[0]!.id,
                rows[1]!.id,
                rows[3]!.id,
                rows[4]!.id,
            );

            expect(getActiveMemoryImportanceHistogram(db, projectPath)).toEqual({
                total: 5,
                unclassified: 1,
                bands: {
                    "0-19": 1,
                    "20-39": 1,
                    "40-59": 1,
                    "60-79": 1,
                    "80-100": 1,
                },
            });

            db.prepare(
                "UPDATE memories SET importance = 50, classified_at = NULL WHERE project_path = ? AND status = 'active'",
            ).run(projectPath);
            expect(getActiveMemoryImportanceHistogram(db, projectPath)).toEqual({
                total: 5,
                unclassified: 5,
                bands: {
                    "0-19": 0,
                    "20-39": 0,
                    "40-59": 5,
                    "60-79": 0,
                    "80-100": 0,
                },
            });
        } finally {
            closeQuietly(db);
        }
    });
});
