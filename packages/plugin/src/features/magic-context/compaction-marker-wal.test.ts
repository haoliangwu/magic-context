import { expect, it, spyOn } from "bun:test";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import * as logger from "../../shared/logger";
import { fixture, hostStore, messageId, SESSION } from "./__tests__/host-stalls.fixture";
import {
    closeCompactionMarkerDb,
    injectCompactionMarker,
    prepareCompactionMarkerCandidates,
    replaceCompactionMarker,
} from "./compaction-marker";

it("marker commit does not backfill the host writer's accumulated WAL", async () => {
    const f = fixture();
    const oldHome = process.env.XDG_DATA_HOME;
    const oldDb = process.env.OPENCODE_DB;
    process.env.XDG_DATA_HOME = f.dir;
    const path = join(f.dir, "opencode/opencode.db");
    process.env.OPENCODE_DB = path;
    mkdirSync(join(f.dir, "opencode"));
    const host = hostStore(path, 160_000);
    const logs = spyOn(logger, "log");
    try {
        const args = {
            sessionId: SESSION,
            endOrdinal: 150_000,
            endMessageId: messageId(149_999),
            summaryText: "summary",
            directory: f.dir,
            resolvedBoundary: { id: messageId(149_999), timeCreated: 49_999 },
        };
        expect(await prepareCompactionMarkerCandidates(SESSION)).toBe(true);
        const current = injectCompactionMarker(args);
        expect(current).not.toBeNull();
        expect(await prepareCompactionMarkerCandidates(SESSION)).toBe(true);

        host.exec("PRAGMA wal_checkpoint(TRUNCATE); PRAGMA wal_autocheckpoint=0");
        const insert = host.prepare("INSERT INTO part VALUES (?,?,?,?,?,?)");
        host.transaction(() => {
            for (let i = 0; i < 4096; i++)
                insert.run(
                    `large-${i}`,
                    messageId(i),
                    SESSION,
                    i,
                    i,
                    JSON.stringify({ type: "text", text: "x".repeat(4096) }),
                );
        })();
        // SQLite's wal-index checkpoint header stores nBackfill at byte 96.
        // Reading it observes actual checkpoint work without issuing a checkpoint.
        const backfilled = () => readFileSync(`${path}-shm`).readUInt32LE(96);
        const before = backfilled();
        expect(before).toBe(0);
        expect(readFileSync(`${path}-shm`).readUInt32LE(16)).toBeGreaterThan(1000);
        let clock = performance.now();
        const time = spyOn(performance, "now").mockImplementation(() => (clock += 101));
        try {
            const result = replaceCompactionMarker(current, {
                ...args,
                endOrdinal: 160_000,
                endMessageId: messageId(159_999),
                resolvedBoundary: { id: messageId(159_999), timeCreated: 53_333 },
            });
            expect(result.kind).toBe("committed");
        } finally {
            time.mockRestore();
        }
        expect(backfilled()).toBe(before);
        expect(logs.mock.calls.map(([line]) => line).join("\n")).toMatch(
            /slow writer site=compaction-marker-replace acquire_ms=[\d.]+ statements_ms=[\d.]+ commit_ms=[\d.]+ wal_autocheckpoint=0 wal_pages_before=\d+ wal_pages_after=\d+/,
        );
        // Restore the host writer's 1,000-page auto-checkpoint policy. Its next
        // write must backfill the WAL that the marker connection left alone.
        host.exec("PRAGMA wal_autocheckpoint=1000");
        host.prepare("UPDATE part SET time_updated=time_updated+1 WHERE id='large-0'").run();
        expect(backfilled()).toBeGreaterThan(1000);
    } finally {
        logs.mockRestore();
        closeCompactionMarkerDb();
        host.close();
        if (oldHome === undefined) delete process.env.XDG_DATA_HOME;
        else process.env.XDG_DATA_HOME = oldHome;
        if (oldDb === undefined) delete process.env.OPENCODE_DB;
        else process.env.OPENCODE_DB = oldDb;
        f.cleanup();
    }
});
