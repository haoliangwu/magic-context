import { expect, test } from "bun:test";
import { runMigrations } from "../../features/magic-context/migrations";
import { initializeDatabase } from "../../features/magic-context/storage-db";
import { Database } from "../../shared/sqlite";
import type { SessionContext, V2Context } from "../hooks/types";
import type { StoreRow, V2StoreReader } from "../store-reader";
import { nativeFoldCache } from "./memory-cache";
import { NativeFoldReplay } from "./native-replay";
import { foldDigest } from "./owner";

function fixture(getSetOnly = false) {
    const db = new Database(":memory:");
    initializeDatabase(db);
    runMigrations(db);
    const records = new Map<string, unknown>();
    const storage: V2Context["storage"] = {
        get: async (key) => records.get(key),
        set: async (key, value) => {
            records.set(key, value);
        },
        remove: async (key) => {
            records.delete(key);
        },
        scan: async ({ prefix, after }) => {
            const keys = [...records.keys()]
                .sort()
                .filter((key) => key.startsWith(prefix) && (!after || key > after));
            return {
                entries: keys.slice(0, 1).map((key) => ({ key, value: records.get(key) })),
                next: keys.length > 1 ? keys[0] : undefined,
            };
        },
    };
    if (getSetOnly) {
        delete storage.remove;
        delete storage.scan;
    }
    const reader = {
        hostIdentity: () => "private-store",
        latestRunningCompaction: () => ({ id: "cut" }),
        latestSequence: () => 2,
        range: () => [],
        close() {},
    } as unknown as V2StoreReader;
    const cut: StoreRow<"compaction"> = {
        session_id: "s",
        id: "cut",
        type: "compaction",
        seq: 2,
        data: { status: "completed", summary: "PRIVATE_SUMMARY" },
    };
    const replay = () => new NativeFoldReplay(nativeFoldCache(db), () => reader, storage);
    return { db, records, reader, cut, replay };
}

test("session deletion before the first post-restart context pass revokes durable fold admission", async () => {
    // A get/set-only host cannot remove admissions through optional storage APIs.
    const f = fixture(true);
    try {
        const first = f.replay();
        await first.observeSource("s", f.reader);
        await first.storage.saveTail(
            "s",
            JSON.stringify({ model: "p/m", sourceSeq: 1, baseline: "PRIVATE_SUMMARY" }),
            [],
        );
        expect(
            await first.supply({
                draft: { sessionID: "s", model: { providerID: "p", id: "m" } } as SessionContext,
                reader: f.reader,
                summary: "PRIVATE_SUMMARY",
            }),
        ).toBe(true);
        expect(f.records.size).toBe(1);

        // Deletion may arrive before the restarted replay has observed the host store.
        await f.replay().forget("s");
        expect(await f.replay().admits("s", f.cut, f.reader)).toBe(false);
    } finally {
        f.db.close();
    }
});

test("durable provenance stores digests and rejects every mismatched coordinate after restart", async () => {
    const f = fixture();
    try {
        const first = f.replay();
        await first.storage.saveTail("s", JSON.stringify({ model: "p/m", sourceSeq: 1 }), []);
        expect(
            await first.supply({
                draft: { sessionID: "s", model: { providerID: "p", id: "m" } } as SessionContext,
                reader: f.reader,
                summary: "PRIVATE_SUMMARY",
            }),
        ).toBe(true);
        const [key, value] = [...f.records][0]!;
        const saved = value as { payload: string; digest: string };
        expect(key).toBe("native-fold/v2/s");
        expect(saved.payload).not.toContain("PRIVATE_SUMMARY");
        expect(saved.payload).not.toContain("private-store");
        expect(await f.replay().admits("s", f.cut, f.reader)).toBe(true);
        for (const patch of [
            { sourceDigest: "other" },
            { sessionID: "other" },
            { admissionID: "other" },
            { summaryDigest: "other" },
        ]) {
            const payload = JSON.stringify({ ...JSON.parse(saved.payload), ...patch });
            f.records.set(key, { payload, digest: foldDigest(payload) });
            expect(await f.replay().admits("s", f.cut, f.reader)).toBe(false);
        }
        f.records.set(key, { ...saved, digest: "corrupt" });
        expect(await f.replay().admits("s", f.cut, f.reader)).toBe(false);
    } finally {
        f.db.close();
    }
});

test("unobserved deletion removes all legacy source records across scan pages without touching another session", async () => {
    const f = fixture();
    try {
        for (const source of ["a", "b", "c"]) {
            f.records.set(`native-fold/v1/${source}/s`, { payload: "old private summary" });
            f.records.set(`native-fold/v1/${source}/s-other`, { payload: "other summary" });
        }
        f.records.set("native-fold/v2/s", {});
        await f.replay().forget("s");
        expect([...f.records.keys()]).toEqual([
            "native-fold/v1/a/s-other",
            "native-fold/v1/b/s-other",
            "native-fold/v1/c/s-other",
        ]);
    } finally {
        f.db.close();
    }
});

test("a cold admission rejects changed pre-cut rows in the same physical store and requests one shared refresh", async () => {
    const f = fixture();
    try {
        const row: StoreRow<"user"> = {
            session_id: "s",
            id: "u1",
            type: "user",
            seq: 1,
            data: { text: "original history" },
        };
        f.reader.range = () => [row];
        const first = f.replay();
        await first.storage.saveTail("s", JSON.stringify({ model: "p/m", sourceSeq: 0 }), []);
        expect(
            await first.supply({
                draft: { sessionID: "s", model: { providerID: "p", id: "m" } } as SessionContext,
                reader: f.reader,
                summary: "PRIVATE_SUMMARY",
            }),
        ).toBe(true);
        expect(await f.replay().admits("s", f.cut, f.reader)).toBe(true);
        row.data.text = "edited history";
        const restarted = f.replay();
        expect(await restarted.admits("s", f.cut, f.reader)).toBe(false);
        expect(restarted.sourceChanged("s")).toBe(true);
        expect(restarted.needsHeadRebuild("s")).toBe(true);
        expect(f.records.size).toBe(0);
        expect(await f.replay().admits("s", f.cut, f.reader)).toBe(false);
    } finally {
        f.db.close();
    }
});
