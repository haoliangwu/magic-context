import { expect, it, spyOn } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as logger from "../../shared/logger";
import { Database } from "../../shared/sqlite";
import { fixture, hostStore, messageId, SESSION } from "./__tests__/host-stalls.fixture";
import {
    closeCompactionMarkerDb,
    injectCompactionMarker,
    prepareCompactionMarkerCandidates,
    replaceCompactionMarker,
} from "./compaction-marker";
import {
    isMarkerCandidateBasisCurrent,
    MARKER_CERTIFICATION_SQL,
    prepareMarkerCandidateBasis,
    readMarkerCandidateBasis,
} from "./compaction-marker-candidates";

it("marker certification ignores ordinary and unrelated writes with a bounded indexed suffix", async () => {
    const f = fixture();
    const db = hostStore(join(f.dir, "host.db"), 160_000);
    try {
        expect(await prepareMarkerCandidateBasis(db, SESSION, { acceptMs: 60000 })).toBe(true);
        const basis = readMarkerCandidateBasis(db, SESSION)!;
        const frontier = basis.frontier!;
        const insert = db.prepare("INSERT INTO message VALUES (?,?,?,?,?)");
        db.transaction(() => {
            for (let i = 0; i < 200; i++)
                insert.run(
                    `tail-${i}`,
                    i % 2 ? SESSION : "other",
                    60_000 + i,
                    60_000 + i,
                    JSON.stringify({ role: "user" }),
                );
            insert.run("other-summary", "other", 1, 1, JSON.stringify({ summary: true }));
            db.prepare("UPDATE message SET time_updated=time_updated+1 WHERE id=?").run(
                messageId(1),
            );
        }).immediate();
        const plan = db
            .prepare(`EXPLAIN QUERY PLAN ${MARKER_CERTIFICATION_SQL}`)
            .all(frontier.id, frontier.rowid, SESSION) as Array<{ detail: string }>;
        expect(plan.some((row) => row.detail.includes("INTEGER PRIMARY KEY (rowid>?)"))).toBe(true);
        const times: number[] = [];
        for (let trial = 0; trial < 100; trial++) {
            insert.run(
                `ordinary-${trial}`,
                SESSION,
                61_000 + trial,
                61_000 + trial,
                '{"role":"user"}',
            );
            insert.run(
                `unrelated-${trial}`,
                "other",
                61_000 + trial,
                61_000 + trial,
                '{"role":"user"}',
            );
            const start = performance.now();
            expect(readMarkerCandidateBasis(db, SESSION)).toBe(basis);
            times.push(performance.now() - start);
        }
        expect(basis.frontier?.rowid).toBe(160_401);
        times.sort((a, b) => a - b);
        console.log(
            `marker certification: 160000 old rows + 201 initial tail rows, 2 ordinary/unrelated inserts per check; 100 checks p50=${times[50]!.toFixed(3)}ms p95=${times[95]!.toFixed(3)}ms; frontier advanced to ${basis.frontier?.rowid}`,
        );
    } finally {
        db.close();
        f.cleanup();
    }
}, 60_000);

it("marker frontier mapping detects rowid renumbering and remains safe across VACUUM", async () => {
    const f = fixture();
    const db = hostStore(join(f.dir, "host.db"), 20);
    try {
        expect(await prepareMarkerCandidateBasis(db, SESSION)).toBe(true);
        const before = readMarkerCandidateBasis(db, SESSION)!.frontier!;
        db.prepare("DELETE FROM message WHERE id=?").run(messageId(0));
        db.exec("VACUUM");
        const mapped = db.prepare("SELECT rowid FROM message WHERE id=?").get(before.id) as {
            rowid: number;
        };
        expect(!!readMarkerCandidateBasis(db, SESSION)).toBe(mapped.rowid === before.rowid);
        expect(await prepareMarkerCandidateBasis(db, SESSION)).toBe(true);
        db.prepare("UPDATE message SET rowid=rowid+100 WHERE id=?").run(before.id);
        expect(readMarkerCandidateBasis(db, SESSION)).toBeUndefined();
    } finally {
        db.close();
        f.cleanup();
    }
});

it("deleting the frontier and reusing its rowid for a summary defers cleanup", async () => {
    const f = fixture();
    const db = hostStore(join(f.dir, "host.db"), 20);
    try {
        expect(await prepareMarkerCandidateBasis(db, SESSION)).toBe(true);
        const basis = readMarkerCandidateBasis(db, SESSION)!;
        const before = basis.frontier!;
        db.prepare("DELETE FROM message WHERE id=?").run(before.id);
        expect(isMarkerCandidateBasisCurrent(db, basis)).toBe(false);
        db.prepare("INSERT INTO message VALUES (?,?,?,?,?)").run(
            "reused-summary",
            SESSION,
            null,
            1,
            JSON.stringify({ summary: true }),
        );
        expect(
            (
                db.prepare("SELECT rowid FROM message WHERE id='reused-summary'").get() as {
                    rowid: number;
                }
            ).rowid,
        ).toBe(before.rowid);
        // The old rowid/ID pair no longer identifies the last scanned row,
        // even though the new summary restored the same numeric maximum.
        expect(isMarkerCandidateBasisCurrent(db, basis)).toBe(false);
        expect(readMarkerCandidateBasis(db, SESSION)).toBeUndefined();
        expect(await prepareMarkerCandidateBasis(db, SESSION)).toBe(true);
        expect(readMarkerCandidateBasis(db, SESSION)?.ids).toContain("reused-summary");
    } finally {
        db.close();
        f.cleanup();
    }
});

it("a host message table without rowids defers with an explicit worker error", async () => {
    const f = fixture();
    const db = new Database(join(f.dir, "host.db"));
    db.exec("CREATE TABLE message(id TEXT PRIMARY KEY,session_id TEXT,data TEXT) WITHOUT ROWID");
    const logs = spyOn(logger, "log");
    try {
        expect(await prepareMarkerCandidateBasis(db, SESSION)).toBe(false);
        expect(readMarkerCandidateBasis(db, SESSION)).toBeUndefined();
        const errors = logs.mock.calls.filter(([line]) =>
            String(line).includes("[ERROR] compaction-marker: candidate worker unavailable"),
        );
        expect(errors).toHaveLength(1);
        expect(errors[0]?.[0]).toContain("compaction-marker-candidates-worker.ts");
        expect(errors[0]?.[0]).toContain("rowid");
    } finally {
        logs.mockRestore();
        db.close();
        f.cleanup();
    }
});

it("our own in-place summary upsert between scan and certification defers the cut", async () => {
    const f = fixture();
    const oldHome = process.env.XDG_DATA_HOME;
    process.env.XDG_DATA_HOME = f.dir;
    mkdirSync(join(f.dir, "opencode"));
    const path = join(f.dir, "opencode/opencode.db");
    const db = hostStore(path, 20);
    const peer = new Database(path);
    try {
        const args = {
            sessionId: SESSION,
            endMessageId: messageId(12),
            endOrdinal: 13,
            summaryText: "summary",
            directory: f.dir,
        };
        expect(await prepareCompactionMarkerCandidates(SESSION)).toBe(true);
        const marker = injectCompactionMarker(args)!;
        expect(marker).not.toBeNull();
        // Clear the marker's summary flag in the fixture before two connections
        // scan it. Restoring summary=true on that ID must invalidate the other
        // connection's pending scan even though the rowid does not change.
        db.prepare(
            "UPDATE message SET data=json_set(data,'$.summary',json('false')) WHERE id=?",
        ).run(marker.summaryMessageId);
        expect(await prepareCompactionMarkerCandidates(SESSION)).toBe(true);
        const entry = join(f.dir, "paused-snapshot.mjs");
        writeFileSync(
            entry,
            `import {parentPort,workerData} from 'node:worker_threads';
            import {existsSync,writeFileSync} from 'node:fs';
            parentPort.postMessage({kind:'accepted'});
            const {Database}=await import(${JSON.stringify(new URL("../../shared/sqlite.ts", import.meta.url).href)});
            const {scanMarkerCandidateSnapshot}=await import(${JSON.stringify(new URL("./compaction-marker-candidates.ts", import.meta.url).href)});
            const db=new Database(workerData.path,{readonly:true});
            const snapshot=scanMarkerCandidateSnapshot(db,workerData.sessionId);db.close();
            writeFileSync(workerData.path+'.ready','ready');
            while(!existsSync(workerData.path+'.release'))await new Promise(r=>setTimeout(r,5));
            parentPort.postMessage({kind:'candidates',snapshot});parentPort.close();`,
        );
        const pending = prepareMarkerCandidateBasis(peer, SESSION, {
            entry: new URL(`file://${entry}`),
            acceptMs: 60000,
            resultMs: 60000,
        });
        const deadline = Date.now() + 60000;
        while (!existsSync(`${path}.ready`)) {
            if (Date.now() > deadline) throw new Error("summary scan barrier not reached");
            await Bun.sleep(5);
        }
        expect(injectCompactionMarker(args)).not.toBeNull();
        writeFileSync(`${path}.release`, "go");
        expect(await pending).toBe(false);
        expect(readMarkerCandidateBasis(peer, SESSION)).toBeUndefined();
        expect(replaceCompactionMarker(marker, args).kind).toBe("deferred");
        expect(
            db.prepare("SELECT id FROM message WHERE id=?").get(marker.summaryMessageId),
        ).not.toBeNull();
    } finally {
        closeCompactionMarkerDb();
        peer.close();
        db.close();
        process.env.XDG_DATA_HOME = oldHome;
        f.cleanup();
    }
});
