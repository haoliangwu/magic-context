import { expect, test } from "bun:test";
import { Database } from "../../../shared/sqlite";
import { getMuralCueState } from "../mural/storage-mural-cues";
import { getUnclassifiedMemoryIds } from "./storage-memory";
import { getMemoryVerifications, getUnmappedMemoryIds } from "./storage-memory-verifications";

test("memory side-table readers handle 60k ids while preserving input and file ordering", () => {
    const db = new Database(":memory:");
    try {
        db.exec(`CREATE TABLE memories (id INTEGER PRIMARY KEY, classified_at INTEGER, mural_cue TEXT, mural_cue_hash TEXT);
            CREATE TABLE memory_verifications (memory_id INTEGER, file_path TEXT, verified_at INTEGER, mapped_at INTEGER, mapping_origin TEXT);
            INSERT INTO memories VALUES (1, NULL, 'first', 'hash1'), (60000, 42, 'last', 'hash2');
            INSERT INTO memory_verifications VALUES (1, 'z.ts', 2, 3, 'mapper'), (1, 'a.ts', 4, 5, 'mapper'), (60000, '', 0, 8, 'host_rejected_fallback');`);
        const ids = Array.from({ length: 60000 }, (_, i) => 60000 - i);
        expect(getMuralCueState(db, [...ids, 1, Number.NaN])).toEqual(
            new Map([
                [1, { cue: "first", hash: "hash1" }],
                [60000, { cue: "last", hash: "hash2" }],
            ]),
        );
        expect(getMemoryVerifications(db, ids)).toEqual(
            new Map([
                [
                    1,
                    {
                        files: ["a.ts", "z.ts"],
                        verifiedAt: 4,
                        mappedAt: 5,
                        hasSentinel: false,
                        mappingOrigin: "mapper",
                    },
                ],
                [
                    60000,
                    {
                        files: [],
                        verifiedAt: 0,
                        mappedAt: 8,
                        hasSentinel: true,
                        mappingOrigin: "host_rejected_fallback",
                    },
                ],
            ]),
        );
        expect(getUnclassifiedMemoryIds(db, [...ids, 1, 0.5])).toEqual(ids.slice(1));
        expect(getUnmappedMemoryIds(db, [...ids, 1, 0.5])).toEqual(ids.slice(1, -1));
    } finally {
        db.close();
    }
});
