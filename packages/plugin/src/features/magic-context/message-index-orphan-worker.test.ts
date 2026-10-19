import { afterEach, expect, it } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
    runSessionWarmupWorker,
    stopRawSessionOrdinalWarmups,
} from "../../hooks/magic-context/raw-ordinal-warmup";
import { _resetHarnessForTesting, setHarness } from "../../shared/harness";
import { Database } from "../../shared/sqlite";
import { contextStore, fixture } from "./__tests__/host-stalls.fixture";
import { sweepOrphanedOpenCodeMessageIndexes as syncSweep } from "./message-index";
import { sweepOrphanedOpenCodeMessageIndexesOffThread as workerSweep } from "./message-index-async";

afterEach(() => {
    stopRawSessionOrdinalWarmups();
    _resetHarnessForTesting();
});
const options = { now: 2_000_000_000_000, cooldownMs: 0, batchSize: 2 };
function context(path: string) {
    const db = contextStore(path);
    db.exec("DELETE FROM tags; DELETE FROM message_history_index");
    for (let i = 0; i < 8; i++) {
        const id = `ses-${i}`;
        db.prepare(`INSERT INTO message_history_index(session_id,harness,last_indexed_ordinal,dirty_floor_ordinal,updated_at)
            VALUES (?,'opencode',1,0,?)`).run(id, i === 6 ? options.now : 1);
        db.prepare(`INSERT INTO tags(session_id,message_id,type,tag_number,token_count,harness)
            VALUES (?,'message:p0','message',1,20,'opencode')`).run(id);
        db.prepare(`INSERT INTO tags(session_id,message_id,type,tag_number,token_count,harness)
            VALUES (?,'pi:p0','message',2,20,'pi')`).run(id);
    }
    return db;
}
function host(path: string) {
    const db = new Database(path);
    db.exec("PRAGMA journal_mode=WAL; CREATE TABLE session(id TEXT PRIMARY KEY)");
    db.prepare("INSERT INTO session VALUES (?)").run("ses-3");
    return db;
}
function snapshot(db: Database) {
    return {
        tags: db
            .prepare(
                "SELECT session_id,harness,message_id FROM tags ORDER BY session_id,harness,message_id",
            )
            .all(),
        indexes: db
            .prepare("SELECT * FROM message_history_index ORDER BY session_id,harness")
            .all(),
        cursor: db.prepare("SELECT * FROM message_history_orphan_sweep ORDER BY harness").all(),
    };
}

it("worker orphan pages match synchronous deletions, live and young rows, and persisted cursors", async () => {
    const f = fixture();
    setHarness("opencode");
    const db = context(join(f.dir, "context.db"));
    const control = context(join(f.dir, "control.db"));
    const source = host(join(f.dir, "host.db"));
    try {
        for (let page = 0; page < 5; page++) {
            const open = () => new Database(join(f.dir, "host.db"), { readonly: true });
            expect(await workerSweep(db, open, options)).toEqual(syncSweep(control, open, options));
            expect(snapshot(db)).toEqual(snapshot(control));
        }
        expect(
            db
                .prepare("SELECT session_id FROM tags WHERE harness='opencode' ORDER BY session_id")
                .all(),
        ).toEqual([{ session_id: "ses-3" }, { session_id: "ses-6" }]);
        expect(db.prepare("SELECT count(*) n FROM tags WHERE harness='pi'").get()).toEqual({
            n: 8,
        });
    } finally {
        source.close();
        db.close();
        control.close();
        f.cleanup();
    }
});

it("unavailable source and failed worker preserve orphan rows without advancing deletion cursors", async () => {
    const f = fixture();
    setHarness("opencode");
    const db = context(join(f.dir, "context.db"));
    const control = context(join(f.dir, "control.db"));
    const source = host(join(f.dir, "host.db"));
    try {
        expect(await workerSweep(db, () => null, options)).toEqual(
            syncSweep(control, () => null, options),
        );
        expect(snapshot(db)).toEqual(snapshot(control));
        const before = snapshot(db);
        const reply = await runSessionWarmupWorker(
            {
                path: join(f.dir, "context.db"),
                sessionId: "",
                harness: "opencode",
                orphanSweep: { sourcePath: join(f.dir, "host.db"), options },
            },
            { entry: new URL(`file://${f.dir}/missing.mjs`) },
        );
        expect("failure" in reply).toBe(true);
        expect(snapshot(db)).toEqual(before);
    } finally {
        source.close();
        db.close();
        control.close();
        f.cleanup();
    }
});

// Pause the unchanged synchronous sweep body on its worker connection, exposing
// the window between candidate discovery and the deletion transaction to writes.
function barrierWorker(dir: string, at: "BEGIN IMMEDIATE" | "COMMIT") {
    const modules = new URL("../../", import.meta.url).href;
    const path = join(dir, "barrier-worker.mjs");
    writeFileSync(
        path,
        `import {parentPort,workerData} from 'node:worker_threads';
        import {Database} from '${modules}shared/sqlite.ts';
        import {setHarness} from '${modules}shared/harness.ts';
        import {sweepOrphanedOpenCodeMessageIndexes} from '${modules}features/magic-context/message-index.ts';
        parentPort.postMessage({kind:'accepted'});
        setHarness('opencode');
        const db = new Database(workerData.path);
        const signal = new Int32Array(workerData.indexCancellation);
        const exec = db.exec.bind(db);
        db.exec = (sql) => { if(sql === '${at}') {
            Atomics.store(signal,0,1); Atomics.notify(signal,0);
            Atomics.wait(signal,1,0,10000);
        } return exec(sql); };
        const result = sweepOrphanedOpenCodeMessageIndexes(db,
            () => new Database(workerData.orphanSweep.sourcePath,{readonly:true}),workerData.orphanSweep.options);
        db.close(); parentPort.postMessage({kind:'orphan-sweep',result}); parentPort.close();`,
    );
    return new URL(`file://${path}`);
}
async function reached(signal: Int32Array) {
    if (Atomics.load(signal, 0) === 0) {
        const wait = Atomics.waitAsync(signal, 0, 0, 10000);
        if (wait.async) await wait.value;
    }
    expect(Atomics.load(signal, 0)).toBe(1);
}

it("a newly active index is rechecked under the worker's deletion lock", async () => {
    const f = fixture();
    setHarness("opencode");
    const db = context(join(f.dir, "context.db"));
    const source = host(join(f.dir, "host.db"));
    const signal = new Int32Array(new SharedArrayBuffer(8));
    try {
        const pending = runSessionWarmupWorker(
            {
                path: join(f.dir, "context.db"),
                sessionId: "",
                harness: "opencode",
                indexCancellation: signal.buffer as SharedArrayBuffer,
                orphanSweep: { sourcePath: join(f.dir, "host.db"), options },
            },
            { entry: barrierWorker(f.dir, "BEGIN IMMEDIATE") },
        );
        await reached(signal);
        db.prepare("UPDATE message_history_index SET updated_at=? WHERE session_id='ses-0'").run(
            options.now,
        );
        Atomics.store(signal, 1, 1);
        Atomics.notify(signal, 1);
        const reply = await pending;
        expect("orphanSweep" in reply).toBe(true);
        expect(
            db.prepare("SELECT 1 FROM tags WHERE session_id='ses-0' AND harness='opencode'").get(),
        ).not.toBeNull();
    } finally {
        stopRawSessionOrdinalWarmups();
        source.close();
        db.close();
        f.cleanup();
    }
});

it("a live session's newly tagged rows must not be deleted between source probe and worker commit", async () => {
    const f = fixture();
    setHarness("opencode");
    const db = context(join(f.dir, "context.db"));
    const source = host(join(f.dir, "host.db"));
    const signal = new Int32Array(new SharedArrayBuffer(8));
    try {
        const pending = runSessionWarmupWorker(
            {
                path: join(f.dir, "context.db"),
                sessionId: "",
                harness: "opencode",
                indexCancellation: signal.buffer as SharedArrayBuffer,
                orphanSweep: { sourcePath: join(f.dir, "host.db"), options },
            },
            { entry: barrierWorker(f.dir, "BEGIN IMMEDIATE") },
        );
        await reached(signal);
        source.prepare("INSERT INTO session VALUES ('ses-0')").run();
        db.prepare(`INSERT INTO tags(session_id,message_id,type,tag_number,token_count,harness)
            VALUES ('ses-0','new-live:p0','message',3,30,'opencode')`).run();
        Atomics.store(signal, 1, 1);
        Atomics.notify(signal, 1);
        expect("orphanSweep" in (await pending)).toBe(true);
        expect(
            db.prepare("SELECT 1 FROM tags WHERE message_id='new-live:p0'").get(),
        ).not.toBeNull();
    } finally {
        stopRawSessionOrdinalWarmups();
        source.close();
        db.close();
        f.cleanup();
    }
});

it("shutdown during a worker sweep rolls back deletions and releases the writer lock", async () => {
    const f = fixture();
    setHarness("opencode");
    const db = context(join(f.dir, "context.db"));
    const source = host(join(f.dir, "host.db"));
    const signal = new Int32Array(new SharedArrayBuffer(8));
    try {
        const before = snapshot(db);
        const pending = runSessionWarmupWorker(
            {
                path: join(f.dir, "context.db"),
                sessionId: "",
                harness: "opencode",
                indexCancellation: signal.buffer as SharedArrayBuffer,
                orphanSweep: { sourcePath: join(f.dir, "host.db"), options },
            },
            { entry: barrierWorker(f.dir, "COMMIT") },
        );
        await reached(signal);
        stopRawSessionOrdinalWarmups();
        expect("failure" in (await pending)).toBe(true);
        expect(snapshot(db)).toEqual(before);
        db.exec("BEGIN IMMEDIATE; ROLLBACK");
    } finally {
        source.close();
        db.close();
        f.cleanup();
    }
});

it("host exit and SIGKILL during a worker transaction leave no committed deletions or writer lock", async () => {
    const f = fixture();
    setHarness("opencode");
    const db = context(join(f.dir, "context.db"));
    const source = host(join(f.dir, "host.db"));
    const modules = new URL("../../", import.meta.url).href;
    try {
        for (const mode of ["exit", "SIGKILL"]) {
            const before = snapshot(db);
            const entry = barrierWorker(f.dir, "COMMIT");
            const path = join(f.dir, `exiting-host-${mode}.mjs`);
            writeFileSync(
                path,
                `import {runSessionWarmupWorker} from '${modules}hooks/magic-context/raw-ordinal-warmup.ts';
                const keepAlive = setInterval(()=>{},1000);
                const signal = new Int32Array(new SharedArrayBuffer(8));
                void runSessionWarmupWorker({path:${JSON.stringify(join(f.dir, "context.db"))},sessionId:'',harness:'opencode',
                    indexCancellation:signal.buffer,orphanSweep:{sourcePath:${JSON.stringify(join(f.dir, "host.db"))},options:${JSON.stringify(options)}}},
                    {entry:new URL(${JSON.stringify(entry.href)})});
                if(Atomics.load(signal,0)===0) {const wait=Atomics.waitAsync(signal,0,0,10000); if(wait.async) await wait.value;}
                if(Atomics.load(signal,0)!==1) throw Error('worker transaction was not reached');
                console.log('WORKER TRANSACTION OPEN');
                ${mode === "exit" ? "process.exit(0);" : "process.kill(process.pid,'SIGKILL');"}`,
            );
            const child = Bun.spawn([process.execPath, path], {
                stdout: "pipe",
                stderr: "pipe",
                windowsHide: true,
            });
            try {
                const status = await child.exited;
                const stdout = await new Response(child.stdout).text();
                const stderr = await new Response(child.stderr).text();
                expect(stdout, stderr).toContain("WORKER TRANSACTION OPEN");
                expect(status).toBe(mode === "exit" ? 0 : 137);
                expect(snapshot(db)).toEqual(before);
                db.exec("BEGIN IMMEDIATE; ROLLBACK");
            } finally {
                child.kill();
            }
        }
    } finally {
        source.close();
        db.close();
        f.cleanup();
    }
});
