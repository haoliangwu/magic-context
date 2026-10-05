/// <reference types="bun-types" />

import { describe, expect, spyOn, test } from "bun:test";
import { Database } from "../../shared/sqlite";
import { markTagsCompactedByMessageIds } from "./storage-tags";

function fixture(): Database {
    const db = new Database(":memory:");
    db.exec(`CREATE TABLE tags (
        id INTEGER PRIMARY KEY, session_id TEXT, message_id TEXT,
        tool_owner_message_id TEXT, status TEXT);
        CREATE INDEX idx_tags_session_message_id ON tags(session_id, message_id);
        CREATE INDEX idx_tags_session_tag_number ON tags(session_id, id);`);
    return db;
}

function legacy(db: Database, session: string, ids: string[]): number {
    const update = db.prepare(`UPDATE tags SET status = 'compacted'
        WHERE session_id = ? AND status IN ('active', 'dropped')
        AND (message_id = ? OR message_id LIKE ? ESCAPE '\\'
            OR message_id LIKE ? ESCAPE '\\' OR tool_owner_message_id = ?) RETURNING id`);
    return db
        .transaction(() => {
            let count = 0;
            for (const id of new Set(ids)) {
                const escaped = id.replace(/[\\%_]/g, "\\$&");
                count += update.all(session, id, `${escaped}:p%`, `${escaped}:file%`, id).length;
            }
            return count;
        })
        .immediate();
}

describe("trimmed-message tag retirement", () => {
    test("retires 100k tags with 4000 trimmed ids within two seconds", () => {
        const db = fixture();
        try {
            const insert = db.prepare("INSERT INTO tags VALUES (?, 's', ?, ?, ?)");
            db.transaction(() => {
                for (let i = 0; i < 100_000; i++) {
                    insert.run(
                        i + 1,
                        i < 8000 ? `m${i % 4000}:p0` : `keep${i}`,
                        i < 8000 ? `m${i % 4000}` : null,
                        i % 3 === 0 ? "compacted" : i % 3 === 1 ? "active" : "dropped",
                    );
                }
            })();
            const start = performance.now();
            expect(
                markTagsCompactedByMessageIds(
                    db,
                    "s",
                    Array.from({ length: 4000 }, (_, i) => `m${i}`),
                ),
            ).toBe(5333);
            const elapsed = performance.now() - start;
            // This full-state expectation is also checked against the legacy SQL
            // on the identical fixture before replacing the quadratic loop.
            const states = db.prepare("SELECT status FROM tags ORDER BY id").all() as {
                status: string;
            }[];
            expect(states.map((row) => row.status)).toEqual(
                Array.from({ length: 100_000 }, (_, i) =>
                    i < 8000 || i % 3 === 0 ? "compacted" : i % 3 === 1 ? "active" : "dropped",
                ),
            );
            console.log(`trim regression: 100000 tags, 4000 ids, ${elapsed.toFixed(1)}ms`);
            expect(elapsed).toBeLessThan(2000);
            expect(markTagsCompactedByMessageIds(db, "s", ["m1", "m1"])).toBe(0);
        } finally {
            db.close();
        }
    }, 600_000);

    test("matches legacy LIKE, exact-id and owner semantics, including nested delimiters", () => {
        for (const ids of [
            ["root", "a%_\\b", "MiXeD", "Ä", "", "owner", "root"],
            ["root:p0", "root:p0"],
            ["nul\0id"],
        ]) {
            const db = fixture();
            try {
                const values = [
                    "root",
                    "root:p",
                    "root:part",
                    "root:FILEanything",
                    "root:p0:file1",
                    "root:mc-text-v1:x",
                    "rootish:p0",
                    "a%_\\b:p0",
                    "axxb:p0",
                    "mixed:p0",
                    "mixed",
                    "Ä:p0",
                    "ä:p0",
                    ":p0",
                    "call-id",
                    "keep",
                    "root:p\0tail",
                    "root\0:p0",
                    "nul",
                    "NUL\0else",
                    "nul:p0",
                    null,
                ];
                const insert = db.prepare("INSERT INTO tags VALUES (?, ?, ?, ?, ?)");
                let id = 0;
                for (const session of ["old", "new", "other"]) {
                    for (const value of values) {
                        for (const status of ["active", "dropped", "compacted", "other"]) {
                            insert.run(
                                ++id,
                                session,
                                value,
                                value === "call-id" || value === null ? "owner" : null,
                                status,
                            );
                        }
                    }
                }
                const read = (session: string) =>
                    db
                        .prepare(
                            "SELECT message_id,tool_owner_message_id,status FROM tags WHERE session_id = ? ORDER BY id",
                        )
                        .all(session);
                const untouched = read("other");
                expect(markTagsCompactedByMessageIds(db, "new", ids)).toBe(legacy(db, "old", ids));
                expect(read("new")).toEqual(read("old"));
                expect(read("other")).toEqual(untouched);
                expect(markTagsCompactedByMessageIds(db, "new", ids)).toBe(0);
            } finally {
                db.close();
            }
        }
    });

    test("commits bounded batches and safely resumes after an interrupted batch", () => {
        const db = fixture();
        try {
            const insert = db.prepare(
                "INSERT INTO tags VALUES (?, 's', 'root:p0', NULL, 'dropped')",
            );
            db.transaction(() => {
                for (let i = 1; i <= 1000; i++) insert.run(i);
            })();
            const exec = db.exec.bind(db);
            let begins = 0;
            const intercept = spyOn(db, "exec").mockImplementation((sql: string) => {
                if (sql === "BEGIN IMMEDIATE" && ++begins === 2)
                    throw new Error("interrupted batch");
                return exec(sql);
            });
            try {
                expect(() => markTagsCompactedByMessageIds(db, "s", ["root"])).toThrow(
                    "interrupted batch",
                );
            } finally {
                intercept.mockRestore();
            }
            const applied = (
                db.prepare("SELECT count(*) AS n FROM tags WHERE status = 'compacted'").get() as {
                    n: number;
                }
            ).n;
            expect(applied).toBeGreaterThan(0);
            expect(applied).toBeLessThanOrEqual(128);
            expect(markTagsCompactedByMessageIds(db, "s", ["root"])).toBe(1000 - applied);
            expect(markTagsCompactedByMessageIds(db, "s", ["root"])).toBe(0);
        } finally {
            db.close();
        }
    });

    test("does not retire tags retargeted between discovery and writer acquisition", () => {
        const db = fixture();
        try {
            db.exec("INSERT INTO tags VALUES (1, 's', 'root:p0', NULL, 'active')");
            const exec = db.exec.bind(db);
            let retargeted = false;
            const intercept = spyOn(db, "exec").mockImplementation((sql: string) => {
                if (sql === "BEGIN IMMEDIATE" && !retargeted) {
                    retargeted = true;
                    exec("UPDATE tags SET message_id = 'keep:p0' WHERE id = 1");
                }
                return exec(sql);
            });
            try {
                expect(markTagsCompactedByMessageIds(db, "s", ["root"])).toBe(0);
            } finally {
                intercept.mockRestore();
            }
            expect(retargeted).toBe(true);
            expect(db.prepare("SELECT status FROM tags WHERE id = 1").get()).toEqual({
                status: "active",
            });
        } finally {
            db.close();
        }
    });
});
