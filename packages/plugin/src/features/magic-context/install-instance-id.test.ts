import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";

import {
    ensureInstallInstanceId,
    INSTALL_INSTANCE_ID_KEY,
    readInstallInstanceId,
} from "./install-instance-id";

function freshDb(): Database {
    const db = new Database(":memory:");
    db.exec("CREATE TABLE schema_migrations_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    return db;
}

describe("install instance id", () => {
    let db: Database;

    beforeEach(() => {
        db = freshDb();
    });

    test("an install that has never claimed anything has no id yet", () => {
        expect(readInstallInstanceId(db)).toBeNull();
    });

    test("reading does not mint", () => {
        readInstallInstanceId(db);
        const count = db
            .prepare("SELECT COUNT(*) AS count FROM schema_migrations_meta WHERE key = ?")
            .get(INSTALL_INSTANCE_ID_KEY) as { count: number };
        expect(count.count).toBe(0);
    });

    test("the id is minted once and stays the same across every later call", () => {
        const first = ensureInstallInstanceId(db);
        expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
        expect(ensureInstallInstanceId(db)).toBe(first);
        expect(readInstallInstanceId(db)).toBe(first);
    });

    test("the id survives reopening the database", () => {
        // A process-random id would change here, and a host could not recognise
        // work it claimed before the restart.
        const minted = ensureInstallInstanceId(db);
        const reopened = freshDb();
        reopened
            .prepare("INSERT INTO schema_migrations_meta (key, value) VALUES (?, ?)")
            .run(INSTALL_INSTANCE_ID_KEY, minted);
        expect(ensureInstallInstanceId(reopened)).toBe(minted);
    });

    test("a caller that loses the race returns the id that actually landed", () => {
        const winner = crypto.randomUUID();
        db.prepare("INSERT INTO schema_migrations_meta (key, value) VALUES (?, ?)").run(
            INSTALL_INSTANCE_ID_KEY,
            winner,
        );
        expect(ensureInstallInstanceId(db)).toBe(winner);
    });

    test("two installs do not share an id", () => {
        expect(ensureInstallInstanceId(db)).not.toBe(ensureInstallInstanceId(freshDb()));
    });

    test("a blank stored value is treated as absent rather than presented as an identity", () => {
        db.prepare("INSERT INTO schema_migrations_meta (key, value) VALUES (?, ?)").run(
            INSTALL_INSTANCE_ID_KEY,
            "   ",
        );
        expect(readInstallInstanceId(db)).toBeNull();
    });
});
