import { expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    LKG_SLOT_CHUNKS_DDL,
    LKG_SLOTS_DDL,
} from "../../features/magic-context/migration-v94-write-split";
import { Database, withSqliteTransformPass } from "../../shared/sqlite";
import { createTestTempDirFromPath } from "../../shared/test-temp-dir";
import { loadPersistedLkgSlot, saveLkgSlotToDb } from "./lkg-persist";
import type { LkgSlot } from "./lkg-slot";

test("slow LKG metadata preparation leaves an independent foreground writer admitted", () => {
    const dir = createTestTempDirFromPath(join(tmpdir(), "mc-lkg-preparation-"));
    const path = join(dir, "context.db");
    const saving = new Database(path);
    saving.exec(`PRAGMA journal_mode=WAL; ${LKG_SLOTS_DDL} ${LKG_SLOT_CHUNKS_DDL}
        CREATE TABLE session_meta(session_id TEXT PRIMARY KEY, trailing_blank_decisions TEXT);
        CREATE TABLE foreground(value INTEGER);`);
    const foreground = new Database(path);
    const digests = Array.from({ length: 5000 }, (_, i) => `digest-${i}`);
    let probes = 0;
    // A slow serializer stands in for large metadata preparation. Probe a real,
    // separate SQLite connection at that exact boundary, not a mocked lock flag.
    Object.defineProperty(digests, "toJSON", {
        value: () => {
            Bun.sleepSync(300);
            withSqliteTransformPass(() =>
                foreground.transaction(() =>
                    foreground.exec("INSERT INTO foreground VALUES (1)"),
                )(),
            );
            probes++;
            return [...digests];
        },
    });
    const slot: LkgSlot = {
        jsonPrefix: JSON.stringify([{ text: "managed request" }]),
        inputIdSeq: digests.map((_, i) => `message-${i}`),
        inputContentDigests: digests,
        inputContentSignatures: digests.map((_, i) => `signature-${i}`),
        lastInputMessageId: "message-4999",
        capturedAt: 1,
    };
    try {
        expect(saveLkgSlotToDb(saving, "session", slot)).toBe(true);
        expect(probes).toBe(2);
        expect(foreground.prepare("SELECT COUNT(*) AS n FROM foreground").get()).toEqual({ n: 2 });
        const loaded = loadPersistedLkgSlot(saving, "session");
        expect(loaded?.jsonPrefix).toBe(slot.jsonPrefix);
        expect(loaded?.inputContentDigests).toEqual([...digests]);
        expect(loaded?.inputContentSignatures).toEqual(slot.inputContentSignatures);
    } finally {
        foreground.close();
        saving.close();
        rmSync(dir, { recursive: true, force: true });
    }
}, 30_000);
