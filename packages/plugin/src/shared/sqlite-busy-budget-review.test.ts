import { expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    Database,
    guardSqliteTransformPass,
    SqliteAcquisitionBusyError,
    withSqliteBackgroundWriter,
    withSqliteTransformPass,
} from "./sqlite";
import { createTestTempDirFromPath } from "./test-temp-dir";

function fixture() {
    const dir = createTestTempDirFromPath(join(tmpdir(), "mc-busy-review-"));
    const path = join(dir, "context.db");
    const db = new Database(path);
    db.exec("PRAGMA busy_timeout=5000; CREATE TABLE result(id INTEGER PRIMARY KEY, n INTEGER)");
    db.exec("INSERT INTO result VALUES (1, 0)");
    return {
        db,
        path,
        close() {
            db.close();
            rmSync(dir, { recursive: true, force: true });
        },
    };
}

async function lock(path: string, mode: "read" | "write" | "exclusive", holdMs: number) {
    const child = Bun.spawn(
        [
            "bun",
            "--eval",
            `import { Database } from "bun:sqlite";
        const db = new Database(process.argv[1]);
        db.exec(process.argv[2] === "read" ? "BEGIN; SELECT * FROM result"
            : process.argv[2] === "write" ? "BEGIN IMMEDIATE" : "BEGIN EXCLUSIVE");
        console.log("LOCKED");
        Bun.sleepSync(Number(process.argv[3]));
        db.exec("COMMIT");
        db.close();`,
            path,
            mode,
            String(holdMs),
        ],
        { stdout: "pipe", stderr: "pipe", windowsHide: true },
    );
    const reader = child.stdout.getReader();
    let output = "";
    while (!output.includes("LOCKED\n")) {
        const chunk = await reader.read();
        if (chunk.done) {
            throw new Error(`locker failed: ${await new Response(child.stderr).text()}`);
        }
        output += new TextDecoder().decode(chunk.value);
    }
    reader.releaseLock();
    return { exited: child.exited };
}

for (const method of ["run", "get", "all", "exec"] as const) {
    test(`a rollback-journal commit BUSY retries ${method} exactly once after the reader leaves`, async () => {
        const { db, path, close } = fixture();
        const sql = "UPDATE result SET n = n + 1 WHERE id = 1";
        const statement = db.prepare(`${sql} RETURNING n`);
        const { exited } = await lock(path, "read", 150);
        try {
            await withSqliteTransformPass(() => {
                if (method === "exec") db.exec(sql);
                else statement[method]();
            });
            expect(db.prepare("SELECT * FROM result").all()).toEqual([{ id: 1, n: 1 }]);
            expect(db.inTransaction).toBe(false);
        } finally {
            expect(await exited).toBe(0);
            close();
        }
    });
}

for (const scope of ["foreground", "background", "unscoped"] as const) {
    test(`exec in ${scope} does not wait on an unrelated attached database schema`, async () => {
        const main = fixture();
        const aux = fixture();
        main.db.prepare("ATTACH DATABASE ? AS aux").run(aux.path);
        const { exited } = await lock(aux.path, "exclusive", 2500);
        try {
            const started = performance.now();
            const operation = () => main.db.exec("UPDATE main.result SET n = n + 1");
            if (scope === "foreground") {
                await withSqliteTransformPass(() => {
                    guardSqliteTransformPass({ assert() {}, remainingMs: () => 75 });
                    operation();
                });
            } else if (scope === "background") withSqliteBackgroundWriter(operation);
            else operation();
            expect(performance.now() - started).toBeLessThan(1500);
            expect(main.db.prepare("SELECT n FROM main.result").get()).toEqual({ n: 1 });
        } finally {
            expect(await exited).toBe(0);
            main.close();
            aux.close();
        }
    }, 10_000);
}

for (const location of ["main", "aux"] as const) {
    test(`BUSY retries leave single-statement effects atomic in ${location}, including AFTER triggers`, async () => {
        const main = fixture();
        const aux = fixture();
        main.db.prepare("ATTACH DATABASE ? AS aux").run(aux.path);
        main.db.exec("CREATE TABLE audit(n INTEGER)");
        main.db.exec(`CREATE TEMP TRIGGER audit_insert AFTER INSERT ON ${location}.result
            BEGIN INSERT INTO audit VALUES (new.n); END`);
        main.db.exec(`CREATE TEMP TRIGGER audit_update AFTER UPDATE ON ${location}.result
            BEGIN INSERT INTO audit VALUES (new.n); END`);
        main.db.exec(`CREATE TEMP TRIGGER audit_delete AFTER DELETE ON ${location}.result
            BEGIN INSERT INTO audit VALUES (old.n); END`);
        const forms = [
            `INSERT INTO ${location}.result VALUES (2, 10)`,
            `INSERT OR IGNORE INTO ${location}.result VALUES (2, 20)`,
            `INSERT OR REPLACE INTO ${location}.result VALUES (2, 30)`,
            `INSERT INTO ${location}.result VALUES (2, 40) ON CONFLICT(id) DO UPDATE SET n=n+1`,
            `UPDATE ${location}.result SET n=n+1 WHERE id=2`,
            `DELETE FROM ${location}.result WHERE id=2`,
        ];
        try {
            for (const sql of forms) {
                const statement = main.db.prepare(`${sql} RETURNING *`);
                const blocker = new Database(location === "main" ? main.path : aux.path);
                blocker.exec("BEGIN IMMEDIATE");
                main.db.exec("PRAGMA busy_timeout=0");
                const before = main.db
                    .prepare(`SELECT * FROM ${location}.result ORDER BY id`)
                    .all();
                const beforeAudit = main.db.prepare("SELECT * FROM audit").all();
                try {
                    expect(() => statement.all()).toThrow("locked");
                    expect(
                        main.db.prepare(`SELECT * FROM ${location}.result ORDER BY id`).all(),
                    ).toEqual(before);
                    expect(main.db.prepare("SELECT * FROM audit").all()).toEqual(beforeAudit);
                    expect(main.db.inTransaction).toBe(false);
                } finally {
                    blocker.exec("ROLLBACK");
                    blocker.close();
                }
                const { exited } = await lock(
                    location === "main" ? main.path : aux.path,
                    "write",
                    60,
                );
                try {
                    await withSqliteTransformPass(() => statement.all());
                } finally {
                    expect(await exited).toBe(0);
                }
            }
            expect(main.db.prepare(`SELECT * FROM ${location}.result ORDER BY id`).all()).toEqual([
                { id: 1, n: 0 },
            ]);
            expect(main.db.prepare("SELECT * FROM audit").all()).toEqual([
                { n: 10 },
                { n: 30 },
                { n: 31 },
                { n: 32 },
                { n: 32 },
            ]);
        } finally {
            main.close();
            aux.close();
        }
    }, 10_000);
}

test("an attached DML-only committed prefix is not replayed after a later BUSY", () => {
    const main = fixture();
    const free = fixture();
    const blocked = fixture();
    try {
        main.db.prepare("ATTACH DATABASE ? AS free").run(free.path);
        main.db.prepare("ATTACH DATABASE ? AS blocked").run(blocked.path);
        blocked.db.exec("BEGIN IMMEDIATE");
        withSqliteTransformPass(() => {
            expect(() =>
                main.db.exec("UPDATE free.result SET n=n+1; UPDATE blocked.result SET n=n+1"),
            ).toThrow(SqliteAcquisitionBusyError);
        });
        expect(main.db.prepare("SELECT n FROM free.result").get()).toEqual({ n: 1 });
        expect(main.db.prepare("SELECT n FROM blocked.result").get()).toEqual({ n: 0 });
    } finally {
        blocked.db.exec("ROLLBACK");
        main.close();
        free.close();
        blocked.close();
    }
});

for (const location of ["main", "free"] as const) {
    test(`an ignored AUTOINCREMENT prefix in ${location} is committed only once before a later BUSY`, () => {
        const main = fixture();
        const free = fixture();
        const blocked = fixture();
        try {
            main.db.prepare("ATTACH DATABASE ? AS free").run(free.path);
            main.db.exec(`CREATE TABLE ${location}.numbered(id INTEGER PRIMARY KEY AUTOINCREMENT, value TEXT UNIQUE);
            INSERT INTO ${location}.numbered(value) VALUES ('existing')`);
            main.db.prepare("ATTACH DATABASE ? AS blocked").run(blocked.path);
            blocked.db.exec("BEGIN IMMEDIATE");
            const before = main.db.prepare("SELECT total_changes() AS n").get();
            withSqliteTransformPass(() => {
                guardSqliteTransformPass({ assert() {}, remainingMs: () => 50 });
                expect(() =>
                    main.db.exec(
                        `INSERT OR IGNORE INTO ${location}.numbered(value) VALUES ('existing'); UPDATE blocked.result SET n=n+1`,
                    ),
                ).toThrow(SqliteAcquisitionBusyError);
            });
            expect(main.db.prepare("SELECT total_changes() AS n").get()).toEqual(before);
            expect(
                main.db
                    .prepare(`SELECT seq FROM ${location}.sqlite_sequence WHERE name='numbered'`)
                    .get(),
            ).toEqual({ seq: 2 });
            expect(main.db.prepare(`SELECT * FROM ${location}.numbered`).all()).toEqual([
                { id: 1, value: "existing" },
            ]);
        } finally {
            blocked.db.exec("ROLLBACK");
            main.close();
            free.close();
            blocked.close();
        }
    });
}

test("a WAL BUSY_SNAPSHOT in an explicit read transaction is not retried", () => {
    const { db, path, close } = fixture();
    db.exec("PRAGMA journal_mode=WAL");
    const other = new Database(path);
    try {
        db.exec("BEGIN; SELECT * FROM result");
        other.exec("UPDATE result SET n=n+1");
        withSqliteTransformPass(() => {
            expect(() => db.prepare("UPDATE result SET n=n+10").run()).toThrow("locked");
        });
        expect(db.inTransaction).toBe(true);
        db.exec("ROLLBACK");
        expect(db.prepare("SELECT n FROM result").get()).toEqual({ n: 1 });
    } finally {
        if (db.inTransaction) db.exec("ROLLBACK");
        other.close();
        close();
    }
});

test("a BUSY from an AFTER trigger writing an attached database rolls back the outer statement", async () => {
    const main = fixture();
    const aux = fixture();
    main.db.prepare("ATTACH DATABASE ? AS aux").run(aux.path);
    // The TEMP trigger resolves an unqualified table in main first; give the
    // attached target its own name so the trigger must write the other file.
    main.db.exec("ALTER TABLE aux.result RENAME TO attached_result");
    main.db.exec(`CREATE TEMP TRIGGER update_aux AFTER UPDATE ON main.result
        BEGIN UPDATE attached_result SET n=n+1 WHERE id=1; END`);
    const statement = main.db.prepare("UPDATE main.result SET n=n+1 RETURNING n");
    const blocker = new Database(aux.path);
    try {
        blocker.exec("BEGIN IMMEDIATE");
        main.db.exec("PRAGMA busy_timeout=0");
        expect(() => statement.all()).toThrow("locked");
        expect(main.db.prepare("SELECT n FROM main.result").get()).toEqual({ n: 0 });
        expect(main.db.prepare("SELECT n FROM aux.attached_result").get()).toEqual({ n: 0 });
        expect(main.db.inTransaction).toBe(false);
        blocker.exec("ROLLBACK");
        const { exited } = await lock(aux.path, "write", 100);
        try {
            await withSqliteTransformPass(() => statement.all());
        } finally {
            expect(await exited).toBe(0);
        }
        expect(main.db.prepare("SELECT n FROM main.result").get()).toEqual({ n: 1 });
        expect(main.db.prepare("SELECT n FROM aux.attached_result").get()).toEqual({ n: 1 });
    } finally {
        if (blocker.inTransaction) blocker.exec("ROLLBACK");
        blocker.close();
        main.close();
        aux.close();
    }
});
