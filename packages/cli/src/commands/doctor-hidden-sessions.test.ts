import { describe, expect, test } from "bun:test";
import { Database } from "@magic-context/core/shared/sqlite";
import { listHiddenSessionsFromDatabase } from "./doctor-hidden-sessions";

describe("doctor list-hidden-sessions", () => {
    test("lists only Magic Context hidden-run metadata without mutating rows", () => {
        const db = new Database(":memory:");
        try {
            db.exec(`
                CREATE TABLE session (
                    id TEXT PRIMARY KEY,
                    title TEXT,
                    directory TEXT,
                    time_updated INTEGER,
                    metadata TEXT
                );
            `);
            const insert = db.prepare(
                "INSERT INTO session (id, title, directory, time_updated, metadata) VALUES (?, ?, ?, ?, ?)",
            );
            insert.run(
                "hidden-historian",
                "Magic Context historian",
                "/project",
                30,
                JSON.stringify({ magic_context: "hidden-run", role: "historian" }),
            );
            insert.run(
                "hidden-dreamer",
                "Magic Context dreamer",
                "/project",
                20,
                JSON.stringify({ magic_context: "hidden-run", role: "dreamer" }),
            );
            insert.run(
                "ordinary",
                "User session",
                "/project",
                40,
                JSON.stringify({ role: "user" }),
            );
            insert.run("malformed", "Broken metadata", "/project", 10, "not-json");

            expect(listHiddenSessionsFromDatabase(db)).toEqual([
                {
                    id: "hidden-historian",
                    title: "Magic Context historian",
                    directory: "/project",
                    role: "historian",
                    updatedAt: 30,
                },
                {
                    id: "hidden-dreamer",
                    title: "Magic Context dreamer",
                    directory: "/project",
                    role: "dreamer",
                    updatedAt: 20,
                },
            ]);
            expect(
                (db.prepare("SELECT COUNT(*) AS count FROM session").get() as { count: number })
                    .count,
            ).toBe(4);
        } finally {
            db.close();
        }
    });

    test("returns an empty inventory for a pre-metadata session schema", () => {
        const db = new Database(":memory:");
        try {
            db.exec("CREATE TABLE session (id TEXT PRIMARY KEY)");
            expect(listHiddenSessionsFromDatabase(db)).toEqual([]);
        } finally {
            db.close();
        }
    });
});
