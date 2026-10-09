import { Database as BunDatabase } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import {
    LKG_SLOT_CHUNKS_DDL,
    LKG_SLOTS_DDL,
} from "../../features/magic-context/migration-v94-write-split";
import type { Database } from "../../shared/sqlite";
import {
    clearPersistedLkgSlot,
    drainStaleLkgSlots,
    loadPersistedLkgSlot,
    pruneStaleLkgSlots,
    saveLkgSlotToDb,
} from "./lkg-persist";
import type { LkgSlot } from "./lkg-slot";

function fixture(): { db: Database; raw: BunDatabase } {
    const raw = new BunDatabase(":memory:");
    raw.exec(`${LKG_SLOTS_DDL} ${LKG_SLOT_CHUNKS_DDL}
        CREATE TABLE session_meta (session_id TEXT PRIMARY KEY, trailing_blank_decisions TEXT DEFAULT '');
        CREATE TABLE session_projects (session_id TEXT, updated_at INTEGER);`);
    return { db: raw as unknown as Database, raw };
}

const slot: LkgSlot = {
    jsonPrefix: '[{"text":"one"}]',
    inputIdSeq: ["m1"],
    inputContentDigests: ["digest"],
    lastInputMessageId: "m1",
    modelKey: "model",
    providerKey: "provider",
    capturedAt: 1,
};

describe("LKG durable write discipline", () => {
    it("does not hydrate a durable slot while marker rebuilding admission is fenced", () => {
        const { db, raw } = fixture();
        try {
            expect(saveLkgSlotToDb(db, "ses", slot)).toBe(true);
            raw.query("INSERT INTO session_meta VALUES (?, ?)").run(
                "ses",
                '{"version":2,"trailingBlank":{},"rustMarkerAdmissionFence":true}',
            );
            expect(loadPersistedLkgSlot(db, "ses")).toBeUndefined();
            raw.query("UPDATE session_meta SET trailing_blank_decisions=? WHERE session_id=?").run(
                '{"version":2,"trailingBlank":{}}',
                "ses",
            );
            expect(loadPersistedLkgSlot(db, "ses")?.jsonPrefix).toBe(slot.jsonPrefix);
        } finally {
            raw.close();
        }
    });
    it("writes once for identical passes, but persists a one-byte change and a clear", () => {
        const { db, raw } = fixture();
        try {
            expect(saveLkgSlotToDb(db, "ses", slot)).toBe(true);
            const initial = raw.query("SELECT total_changes() AS count").get() as { count: number };
            for (let i = 0; i < 5; i++)
                expect(saveLkgSlotToDb(db, "ses", { ...slot, capturedAt: i + 2 })).toBe(true);
            expect(
                (raw.query("SELECT total_changes() AS count").get() as { count: number }).count,
            ).toBe(initial.count);
            const changed = { ...slot, jsonPrefix: '[{"text":"onf"}]' };
            expect(saveLkgSlotToDb(db, "ses", changed)).toBe(true);
            expect(loadPersistedLkgSlot(db, "ses")?.jsonPrefix).toBe(changed.jsonPrefix);
            // Two row changes: the prefix's only slice and the slot's metadata row.
            expect(
                (raw.query("SELECT total_changes() AS count").get() as { count: number }).count,
            ).toBe(initial.count + 2);
            clearPersistedLkgSlot(db, "ses");
            expect(saveLkgSlotToDb(db, "ses", changed)).toBe(true);
            expect(loadPersistedLkgSlot(db, "ses")?.jsonPrefix).toBe(changed.jsonPrefix);
        } finally {
            raw.close();
        }
    });

    it("bounds LKG pruning to 25 slices and resumes orphan cleanup without a replayable partial prefix", () => {
        const { db, raw } = fixture();
        try {
            saveLkgSlotToDb(db, "large-old", { ...slot, jsonPrefix: "x".repeat(60 * 65536) });
            const count = () =>
                (raw.query("SELECT COUNT(*) AS n FROM lkg_slot_chunks").get() as { n: number }).n;
            expect(count()).toBe(60);
            expect(pruneStaleLkgSlots(db, 20 * 86400000)).toBe(1);
            expect(count()).toBe(35);
            expect(loadPersistedLkgSlot(db, "large-old")).toBeUndefined();
            expect(pruneStaleLkgSlots(db, 20 * 86400000)).toBe(0);
            expect(count()).toBe(10);
            expect(pruneStaleLkgSlots(db, 20 * 86400000)).toBe(0);
            expect(count()).toBe(0);
        } finally {
            raw.close();
        }
    });

    it("drains orphan-only batches and multiple old slots within one tick", async () => {
        const { db, raw } = fixture();
        try {
            for (let i = 0; i < 3; i++)
                saveLkgSlotToDb(db, `large-old-${i}`, {
                    ...slot,
                    jsonPrefix: "x".repeat(60 * 65536),
                });
            expect(await drainStaleLkgSlots(db, 20 * 86400000)).toBe(3);
            expect(raw.query("SELECT COUNT(*) AS n FROM lkg_slot_chunks").get()).toEqual({ n: 0 });
        } finally {
            raw.close();
        }
    });

    it("prunes old slots but keeps recent captures and recent session bindings", () => {
        const { db, raw } = fixture();
        try {
            const now = 20 * 24 * 60 * 60 * 1000;
            saveLkgSlotToDb(db, "old", slot);
            saveLkgSlotToDb(db, "active", slot);
            saveLkgSlotToDb(db, "recent", { ...slot, capturedAt: now });
            raw.query("INSERT INTO session_projects VALUES (?, ?)").run("active", now);
            expect(pruneStaleLkgSlots(db, now)).toBe(1);
            expect(loadPersistedLkgSlot(db, "old")).toBeUndefined();
            expect(loadPersistedLkgSlot(db, "active")).toBeDefined();
            expect(loadPersistedLkgSlot(db, "recent")).toBeDefined();
            expect(saveLkgSlotToDb(db, "old", slot)).toBe(true);
            expect(loadPersistedLkgSlot(db, "old")).toBeDefined();
        } finally {
            raw.close();
        }
    });
});
