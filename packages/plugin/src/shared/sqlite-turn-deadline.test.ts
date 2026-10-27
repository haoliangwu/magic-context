import { Database as NativeDatabase } from "bun:sqlite";
import { expect, spyOn, test } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    createSqliteTurnDatabase,
    Database,
    withoutSqliteTransformPass,
    withSqliteTurnDeadline,
} from "./sqlite";
import { createTestTempDirFromPath } from "./test-temp-dir";

async function fixture(run: (db: Database, path: string) => Promise<void>) {
    const root = createTestTempDirFromPath(join(tmpdir(), "sqlite-turn-deadline-"));
    const path = join(root, "context.db");
    const db = createSqliteTurnDatabase(path);
    db.exec(
        "PRAGMA journal_mode=DELETE; PRAGMA busy_timeout=900; CREATE TABLE t(value); INSERT INTO t VALUES(1)",
    );
    try {
        await run(db, path);
    } finally {
        db.close();
        rmSync(root, { recursive: true, force: true });
    }
}

async function hold(path: string, reader = false) {
    const child = Bun.spawn(
        [
            process.execPath,
            "-e",
            `
        const { Database } = require('bun:sqlite');
        const db = new Database(process.argv[1]);
        db.exec(${JSON.stringify(reader ? "BEGIN; SELECT * FROM t" : "BEGIN EXCLUSIVE")});
        console.log('HELD');
        setInterval(() => {}, 1000);
    `,
            path,
        ],
        { stdout: "pipe", stderr: "pipe", windowsHide: true },
    );
    const output = child.stdout.getReader();
    const first = await output.read();
    output.releaseLock();
    if (!new TextDecoder().decode(first.value).includes("HELD")) {
        child.kill();
        throw new Error(`holder failed: ${await new Response(child.stderr).text()}`);
    }
    return async () => {
        child.kill();
        await child.exited;
    };
}

function bounded(operation: () => unknown) {
    const start = performance.now();
    expect(() =>
        withSqliteTurnDeadline(() => Math.max(0, 80 - (performance.now() - start)), operation),
    ).toThrow(/locked|busy/i);
    // The connection allows 900 ms; a late turn has only 80 ms left for this wait.
    expect(performance.now() - start).toBeLessThan(400);
    expect(performance.now() - start).toBeGreaterThan(40);
}

test("ordinary connections keep native cached SELECT methods", () => {
    const db = new Database(":memory:");
    const native = new NativeDatabase(":memory:");
    try {
        expect(db.prepare("SELECT 1").get).toBe(native.prepare("SELECT 1").get);
    } finally {
        db.close();
        native.close();
    }
});

test("native deadlines read the connection timeout once, not per cached execution", () => {
    let reads = 0;
    const prepare = Database.prototype.prepare;
    const spy = spyOn(Database.prototype, "prepare").mockImplementation(function (
        this: Database,
        sql: string,
    ) {
        const statement = prepare.call(this, sql);
        if (sql === "PRAGMA busy_timeout") {
            const get = statement.get.bind(statement);
            statement.get = (...args: unknown[]) => {
                reads++;
                return get(...args);
            };
        }
        return statement;
    });
    let db: Database | undefined;
    try {
        db = createSqliteTurnDatabase(":memory:");
        db.exec("PRAGMA busy_timeout=900");
        const query = db.prepare("SELECT 1 AS value");
        withSqliteTurnDeadline(
            () => 80,
            () => {
                for (let i = 0; i < 100; i++) expect(query.get()).toEqual({ value: 1 });
            },
        );
        expect(reads).toBe(1);
        withSqliteTurnDeadline(
            () => 80,
            () => {
                expect(db!.prepare("PRAGMA busy_timeout").get()).toEqual({ timeout: 900 });
            },
        );
    } finally {
        db?.close();
        spy.mockRestore();
    }
});

test("timeout cache follows scripts, prepared setters, comments and failed prefixes", async () => {
    await fixture(async (db, path) => {
        db.exec(
            "PRAGMA main.busy_timeout(900); SELECT '; PRAGMA busy_timeout=0;'; -- PRAGMA busy_timeout=1",
        );
        db.prepare("PRAGMA busy_timeout=800").get();
        expect(db.prepare("PRAGMA busy_timeout").get()).toEqual({ timeout: 800 });
        expect(() => db.exec("PRAGMA busy_timeout=700; SELECT * FROM missing_table")).toThrow();
        const read = db.prepare("SELECT * FROM t");
        const release = await hold(path);
        try {
            bounded(() => read.get());
            expect(db.prepare("PRAGMA busy_timeout").get()).toEqual({ timeout: 700 });
        } finally {
            await release();
        }
    });
});

test("timeout cache follows prepare-time PRAGMA effects", () => {
    const db = createSqliteTurnDatabase(":memory:");
    const physicalTimeout = () =>
        (db.prepare("PRAGMA busy_timeout").get() as { timeout: number }).timeout;
    const harmlessRead = () =>
        withSqliteTurnDeadline(
            () => 80,
            () => db.prepare("SELECT 1").get(),
        );
    try {
        db.exec("PRAGMA busy_timeout=900");
        const setter = db.prepare("PRAGMA busy_timeout=800");
        expect(physicalTimeout()).toBe(800);
        harmlessRead();
        expect(physicalTimeout()).toBe(800);
        db.exec("PRAGMA busy_timeout=700");
        setter.get();
        const before = physicalTimeout();
        harmlessRead();
        expect(physicalTimeout()).toBe(before);
        const iterator = db.prepare("PRAGMA busy_timeout=600").iterate();
        const beforeIteration = physicalTimeout();
        harmlessRead();
        expect(physicalTimeout()).toBe(beforeIteration);
        db.exec("PRAGMA busy_timeout=500");
        iterator.next();
        const afterIteration = physicalTimeout();
        harmlessRead();
        expect(physicalTimeout()).toBe(afterIteration);
        iterator.return?.();
    } finally {
        db.close();
    }
});

for (const method of ["get", "all", "run", "values", "iterate"] as const) {
    test(`turn deadline bounds cached SELECT ${method}`, async () => {
        await fixture(async (db, path) => {
            const statement = db.prepare("SELECT * FROM t") as any;
            const release = await hold(path);
            try {
                bounded(() =>
                    method === "iterate" ? statement.iterate().next() : statement[method](),
                );
                expect(db.prepare("PRAGMA busy_timeout").get()).toEqual({ timeout: 900 });
            } finally {
                await release();
            }
        });
    });
}

test("turn deadline bounds native exec reads", async () => {
    await fixture(async (db, path) => {
        const release = await hold(path);
        try {
            bounded(() => db.exec("SELECT * FROM t"));
        } finally {
            await release();
        }
    });
});

test("turn deadline bounds native schema preparation", async () => {
    await fixture(async (_db, path) => {
        const release = await hold(path);
        const fresh = createSqliteTurnDatabase(path);
        fresh.exec("PRAGMA busy_timeout=900");
        try {
            bounded(() => fresh.prepare("SELECT * FROM t"));
        } finally {
            fresh.close();
            await release();
        }
    });
});

test("turn deadline bounds COMMIT waiting for a reader", async () => {
    await fixture(async (db, path) => {
        db.exec("BEGIN IMMEDIATE; UPDATE t SET value=2");
        const release = await hold(path, true);
        try {
            bounded(() => db.exec("COMMIT"));
            expect(db.inTransaction).toBe(true);
            db.exec("ROLLBACK");
        } finally {
            await release();
        }
    });
});

test("turn deadline bounds execution inside a deferred transaction", async () => {
    await fixture(async (db, path) => {
        const read = db.prepare("SELECT * FROM t");
        db.exec("BEGIN DEFERRED");
        const release = await hold(path);
        try {
            bounded(() => read.get());
        } finally {
            db.exec("ROLLBACK");
            await release();
        }
    });
});

test("turn deadline preserves zero-timeout probes and detached work", async () => {
    await fixture(async (db, path) => {
        const read = db.prepare("SELECT * FROM t");
        const release = await hold(path);
        try {
            withSqliteTurnDeadline(
                () => 80,
                () => {
                    db.exec("PRAGMA busy_timeout=0");
                    expect(db.prepare("PRAGMA busy_timeout").get()).toEqual({ timeout: 0 });
                    expect(() => read.get()).toThrow(/locked|busy/i);
                    db.exec("PRAGMA busy_timeout=900");
                },
            );
            const start = performance.now();
            expect(() =>
                withSqliteTurnDeadline(
                    () => 0,
                    () => withoutSqliteTransformPass(() => read.get()),
                ),
            ).toThrow(/locked|busy/i);
            expect(performance.now() - start).toBeGreaterThan(700);
        } finally {
            await release();
        }
    });
});
