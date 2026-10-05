import type { Database } from "../../shared/sqlite";

type Definition = { type: "table" | "trigger"; name: string; sql: string };

function definitions(db: Database): Definition[] {
    const hasPrivilegeTable = Boolean(
        db
            .prepare(
                "SELECT 1 FROM sqlite_master WHERE type='table' AND name='context_privilege_state'",
            )
            .get(),
    );
    // The module writer sets enabled=1 inside its transaction. Its controlled
    // publications/hints retain the existing rendering and mutation-log policy.
    // Other connections edit with enabled=0 and can bypass m0_mutation_log.
    const externalUpdate = hasPrivilegeTable
        ? "CASE WHEN COALESCE((SELECT enabled FROM context_privilege_state WHERE id=1),0)=0 THEN 1 ELSE 0 END"
        : "1";
    return [
        {
            type: "table",
            name: "compartment_history_versions",
            sql: `CREATE TABLE compartment_history_versions (
            session_id TEXT PRIMARY KEY NOT NULL,
            generation TEXT NOT NULL DEFAULT (lower(hex(randomblob(16)))),
            version INTEGER NOT NULL DEFAULT 0 CHECK (version >= 0),
            rewrite_version INTEGER NOT NULL DEFAULT 0 CHECK (rewrite_version >= 0),
            seeded INTEGER NOT NULL DEFAULT 0 CHECK (seeded IN (0, 1))
        )`,
        },
        {
            type: "trigger",
            name: "compartment_history_ai",
            sql: `CREATE TRIGGER compartment_history_ai AFTER INSERT ON compartments BEGIN
            INSERT INTO compartment_history_versions(session_id, version) VALUES (NEW.session_id, 1)
            ON CONFLICT(session_id) DO UPDATE SET version = version + 1;
        END`,
        },
        {
            type: "trigger",
            name: "compartment_history_ad",
            sql: `CREATE TRIGGER compartment_history_ad AFTER DELETE ON compartments BEGIN
            INSERT INTO compartment_history_versions(session_id, version) VALUES (OLD.session_id, 1)
            ON CONFLICT(session_id) DO UPDATE SET version = version + 1;
        END`,
        },
        {
            type: "trigger",
            name: "compartment_history_au",
            sql: `CREATE TRIGGER compartment_history_au AFTER UPDATE ON compartments BEGIN
            INSERT INTO compartment_history_versions(session_id, version, rewrite_version) VALUES (OLD.session_id, 1, ${externalUpdate})
            ON CONFLICT(session_id) DO UPDATE SET version = version + 1, rewrite_version = rewrite_version + ${externalUpdate};
            INSERT INTO compartment_history_versions(session_id, version, rewrite_version)
                SELECT NEW.session_id, 1, ${externalUpdate} WHERE NEW.session_id != OLD.session_id
            ON CONFLICT(session_id) DO UPDATE SET version = version + 1, rewrite_version = rewrite_version + ${externalUpdate};
        END`,
        },
    ];
}

function installedDefinitions(db: Database): Map<string, string> {
    const rows = db
        .prepare(`SELECT type, name, sql FROM sqlite_master
        WHERE name IN ('compartment_history_versions', 'compartment_history_ai', 'compartment_history_ad', 'compartment_history_au')`)
        .all() as Array<{ type: string; name: string; sql: string }>;
    return new Map(rows.map((row) => [`${row.type}:${row.name}`, row.sql]));
}

function matches(expected: Definition[], installed: Map<string, string>): boolean {
    return expected.every(
        (definition) => installed.get(`${definition.type}:${definition.name}`) === definition.sql,
    );
}

/** Let Rust coordinate validation detect changes without rereading historical summary text. */
export function installCompartmentHistoryVersions(db: Database): void {
    // A partial legacy schema can reach this migration before `compartments`
    // exists. Its triggers need that table, and openDatabase() runs this again
    // after the base schema is in place, so there is nothing to do yet.
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='compartments'").get())
        return;
    // Most opens need no DDL, seeding scan or write lock. Compare SQLite's stored
    // creation text, including the privilege-aware trigger variant, before writing.
    if (matches(definitions(db), installedDefinitions(db))) return;
    db.transaction(() => {
        // Another opener may have completed installation while we waited for its lock.
        // Recheck here; an unchanged open skips this transaction entirely above.
        const expected = definitions(db);
        const installed = installedDefinitions(db);
        if (matches(expected, installed)) return;
        const table = expected[0]!;
        const existingTable = installed.get(`table:${table.name}`);
        if (existingTable !== undefined && existingTable !== table.sql) {
            throw new Error(
                "compartment_history_versions schema differs from v93; refusing to replace revision data",
            );
        }
        if (existingTable === undefined) db.exec(table.sql);
        db.exec(`INSERT OR IGNORE INTO compartment_history_versions(session_id, seeded)
            SELECT DISTINCT session_id, 1 FROM compartments`);
        for (const trigger of expected.slice(1)) {
            if (installed.get(`trigger:${trigger.name}`) === trigger.sql) continue;
            db.exec(`DROP TRIGGER IF EXISTS ${trigger.name}`);
            db.exec(trigger.sql);
        }
    }).immediate();
}
