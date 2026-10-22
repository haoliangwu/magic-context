import { expect, test } from "bun:test";
import { runMigrations } from "../../features/magic-context/migrations";
import { initializeDatabase } from "../../features/magic-context/storage-db";
import { Database } from "../../shared/sqlite";
import type { SessionContext, V2Context } from "../hooks/types";
import type { StoreRow, V2StoreReader } from "../store-reader";
import { nativeFoldCache } from "./memory-cache";
import { NativeFoldReplay } from "./native-replay";

test("session deletion before the first post-restart context pass revokes durable fold admission", async () => {
    const db = new Database(":memory:");
    initializeDatabase(db);
    runMigrations(db);
    const records = new Map<string, unknown>();
    const admissions = {
        get: async (key: string) => records.get(key),
        set: async (key: string, value: unknown) => {
            records.set(key, value);
        },
    } as V2Context["storage"];
    const reader = {
        hostIdentity: () => "private-host-store",
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
        data: { status: "completed", summary: "served baseline" },
    };
    try {
        const memory = nativeFoldCache(db);
        const first = new NativeFoldReplay(memory, () => reader, admissions);
        await first.observeSource("s", reader);
        await memory.saveTail(
            "s",
            JSON.stringify({ model: "p/m", sourceSeq: 1, baseline: "served baseline" }),
            [],
        );
        expect(
            await first.supply({
                draft: { sessionID: "s", model: { providerID: "p", id: "m" } } as SessionContext,
                reader,
                summary: "served baseline",
            }),
        ).toBe(true);
        expect(records.size).toBe(1);

        // A deletion event can be the first event for a session after startup.
        // The new replay instance has not yet recorded this session's host-store identity.
        const restarted = new NativeFoldReplay(nativeFoldCache(db), () => reader, admissions);
        await restarted.forget("s");
        const afterDeletion = new NativeFoldReplay(nativeFoldCache(db), () => reader, admissions);
        expect(await afterDeletion.admits("s", cut, reader)).toBe(false);
    } finally {
        db.close();
    }
});
