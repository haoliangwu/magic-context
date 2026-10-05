// Node-runtime smoke test for the node:sqlite branch of shared/sqlite.ts.
// Bun's `bun test` only exercises the bun:sqlite branch, so this runs the
// REAL wrapper under Node to validate: construction, readonly mapping, the
// transaction() shim (top-level + nested savepoint rollback), exec/prepare/
// run/get/all, and ATTACH. Run with: node packages/plugin/scripts/smoke-node-sqlite.ts
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// NOTE: explicit .ts extension — this script is run directly under Node
// (`node scripts/smoke-node-sqlite.ts`) to exercise the node:sqlite branch that
// `bun test` cannot reach. Node's ESM type-stripping resolver requires the
// extension. The file is excluded from tsconfig.scripts.json for the same
// reason (running it IS the validation).
import { Database, withSqliteTransformPass } from "../src/shared/sqlite.ts";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
    if (cond) {
        console.log(`  ok  ${name}`);
    } else {
        failures++;
        console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
    }
}

const dir = mkdtempSync(join(tmpdir(), "mc-node-sqlite-smoke-"));
const dbPath = join(dir, "smoke.db");
try {
    // Construction + basic DDL/DML.
    const db = new Database(dbPath) as unknown as {
        exec: (s: string) => void;
        prepare: (s: string) => {
            run: (...a: unknown[]) => { changes: number; lastInsertRowid: number | bigint };
            get: (...a: unknown[]) => unknown;
            all: (...a: unknown[]) => unknown[];
        };
        transaction: <F extends (...a: unknown[]) => unknown>(fn: F) => F;
        close: () => void;
        isTransaction?: boolean;
    };
    db.exec("CREATE TABLE t(id INTEGER PRIMARY KEY, v TEXT, flag INTEGER)");
    const ins = db.prepare("INSERT INTO t(v, flag) VALUES(?, ?)");
    const r = ins.run("a", 1);
    check("run() returns changes+lastInsertRowid", r.changes === 1 && Number(r.lastInsertRowid) === 1, JSON.stringify(r));
    check("get() returns row", (db.prepare("SELECT v FROM t WHERE id=?").get(1) as { v: string }).v === "a");

    // Array-form bind normalization (issue #151): bare node:sqlite throws
    // `Unknown named parameter '0'` on `.run([a,b])`; the chokepoint shim must
    // make it behave like bun:sqlite (positional). Exercise run/get with array binds.
    let arrayBindOk = false;
    try {
        db.prepare("INSERT INTO t(v, flag) VALUES(?, ?)").run(["arr", 1]);
        const got = db.prepare("SELECT v FROM t WHERE v=?").get(["arr"]) as { v: string } | undefined;
        arrayBindOk = got?.v === "arr";
        // Clean up so the row-count assertions below stay valid.
        db.prepare("DELETE FROM t WHERE v=?").run(["arr"]);
    } catch (e) {
        arrayBindOk = false;
        check("array-bind normalized to positional", false, (e as Error).message);
    }
    check("array-bind normalized to positional (issue #151)", arrayBindOk);

    // transaction() shim — top-level commit.
    db.transaction(() => {
        db.prepare("INSERT INTO t(v, flag) VALUES(?, ?)").run("b", 0);
    })();
    check("transaction() commits", (db.prepare("SELECT COUNT(*) c FROM t").get() as { c: number }).c === 2);

    // transaction() shim — top-level rollback on throw.
    try {
        db.transaction(() => {
            db.prepare("INSERT INTO t(v, flag) VALUES(?, ?)").run("doomed", 0);
            throw new Error("boom");
        })();
    } catch {
        /* expected */
    }
    check("transaction() rolls back on throw", (db.prepare("SELECT COUNT(*) c FROM t").get() as { c: number }).c === 2);

    // Nested transaction — outer commits, inner savepoint rolls back.
    db.transaction(() => {
        db.prepare("INSERT INTO t(v, flag) VALUES(?, ?)").run("outer", 0);
        try {
            db.transaction(() => {
                db.prepare("INSERT INTO t(v, flag) VALUES(?, ?)").run("inner-doomed", 0);
                throw new Error("inner boom");
            })();
        } catch {
            /* swallow — outer continues */
        }
    })();
    const names = (db.prepare("SELECT v FROM t ORDER BY id").all() as { v: string }[]).map((x) => x.v);
    check("nested savepoint: outer kept, inner rolled back", names.join(",") === "a,b,outer", names.join(","));

    // ATTACH (used by tool-owner-backfill) works under defensive mode.
    const other = new Database(join(dir, "other.db")) as unknown as { exec: (s: string) => void; close: () => void };
    other.exec("CREATE TABLE x(id INTEGER); INSERT INTO x(id) VALUES(42)");
    other.close();
    db.exec(`ATTACH '${join(dir, "other.db")}' AS oc`);
    check("ATTACH + cross-db read", (db.prepare("SELECT id FROM oc.x").get() as { id: number }).id === 42);
    db.exec("DETACH oc");

    db.close();

    // readonly → readOnly mapping.
    const ro = new Database(dbPath, { readonly: true } as never) as unknown as {
        prepare: (s: string) => { get: (...a: unknown[]) => unknown };
        exec: (s: string) => void;
        close: () => void;
    };
    check("readonly open can read", (ro.prepare("SELECT COUNT(*) c FROM t").get() as { c: number }).c === 3);
    let blocked = false;
    try {
        ro.exec("INSERT INTO t(v, flag) VALUES('nope', 0)");
    } catch {
        blocked = true;
    }
    check("readonly open blocks writes", blocked);
    ro.close();

    const writer = new Database(dbPath);
    writer.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=50");
    // A BEGIN inside a transform pass waits up to 250 ms for another writer
    // (the async admission retries, not this synchronous attempt, cover longer
    // holds). A 120 ms hold must be waited out; a 650 ms hold must surface as
    // SqliteAcquisitionBusyError so the pass can replay or refuse.
    const holdLock = (holdMs: number) => {
        const locker = spawn(process.execPath, ["--input-type=module", "-e", `
            import { DatabaseSync } from 'node:sqlite';
            const db = new DatabaseSync(${JSON.stringify(dbPath)});
            db.exec('BEGIN IMMEDIATE');
            console.log('LOCKED');
            setTimeout(() => { db.exec('ROLLBACK'); db.close(); }, ${holdMs});
        `], { stdio: ["ignore", "pipe", "pipe"] });
        const exited = new Promise<void>((resolve, reject) => {
            locker.once("error", reject);
            locker.once("exit", code => code === 0 ? resolve() : reject(new Error(`locker exit ${code}`)));
        });
        const locked = new Promise<void>((resolve, reject) => {
            let output = "";
            locker.stdout.on("data", chunk => { output += String(chunk); if (output.includes("LOCKED")) resolve(); });
            locker.once("error", reject);
        });
        return { exited, locked };
    };
    {
        const { exited, locked } = holdLock(650);
        await locked;
        let threw = "";
        try {
            withSqliteTransformPass(() => {
                writer.transaction(() => writer.prepare("INSERT INTO t(v,flag) VALUES(?,?)").run("long-hold", 1)).immediate();
            });
        } catch (error) {
            threw = error instanceof Error ? error.name : String(error);
        } finally { await exited; }
        check("in-pass acquisition past its budget surfaces SqliteAcquisitionBusyError", threw === "SqliteAcquisitionBusyError");
    }
    for (const mode of ["default", "immediate", "exclusive", "literal"] as const) {
        const { exited, locked } = holdLock(120);
        await locked;
        let callbacks = 0;
        const callback = () => { callbacks++; writer.prepare("INSERT INTO t(v,flag) VALUES(?,?)").run(mode, 1); };
        try {
            withSqliteTransformPass(() => {
                if (mode === "literal") { writer.exec("BEGIN IMMEDIATE"); callback(); writer.exec("COMMIT"); }
                else { const tx = writer.transaction(callback); if (mode === "default") tx(); else tx[mode](); }
            });
            check(`${mode} acquisition retries before callback under node:sqlite`, callbacks === 1);
        } finally { await exited; }
    }
    writer.close();
    const snapshot = new Database(dbPath, { readonly: true });
    check("readonly default transaction stays a read snapshot", snapshot.transaction(() => snapshot.prepare("SELECT COUNT(*) AS n FROM t").get())() !== undefined);
    snapshot.close();
} finally {
    rmSync(dir, { recursive: true, force: true });
}

console.log(failures === 0 ? "\nSMOKE PASS (node:sqlite branch)" : `\nSMOKE FAILED: ${failures} check(s)`);
process.exit(failures === 0 ? 0 : 1);
