import { afterEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestTempDirFromPath } from "../../shared/test-temp-dir";
import {
    appendCompartments,
    getCompartmentsByEndMessageId,
    getUncoveredCompartmentEndThrough,
} from "./compartment-storage";
import { closeDatabase, openDatabase } from "./storage";

const tempDirs: string[] = [];

describe("getUncoveredCompartmentEndThrough", () => {
    test("releases same-message continuation at a later last-block anchor, but not an unknown or earlier anchor", () => {
        useTempDataHome("indexed-continuation-");
        const db = openDatabase();
        appendCompartments(db, "ses", [
            {
                sequence: 0,
                startMessage: 1,
                endMessage: 2,
                startMessageId: "m1",
                endMessageId: "m2",
                endBlockIndex: 1,
                title: "partial",
                content: "partial",
            },
            {
                sequence: 1,
                startMessage: 2,
                endMessage: 4,
                startMessageId: "m2",
                endMessageId: "m4",
                startBlockIndex: 5,
                endBlockIndex: 2,
                title: "continues",
                content: "continues",
            },
        ]);
        expect(getUncoveredCompartmentEndThrough(db, "ses", 2)).toBeNull();
        expect(getUncoveredCompartmentEndThrough(db, "ses")).toEqual({
            endMessageId: "m4",
            endMessage: 4,
        });
        expect(getUncoveredCompartmentEndThrough(db, "other")).toBeNull();
        for (const anchor of [null, 0, 1]) {
            db.prepare(
                "UPDATE compartments SET start_block_index=? WHERE session_id='ses' AND sequence=1",
            ).run(anchor);
            expect(getUncoveredCompartmentEndThrough(db, "ses", 2)).toEqual({
                endMessageId: "m2",
                endMessage: 2,
            });
        }
    });

    test("next ordinal releases an indexed end even at a nonzero start anchor, but gaps do not", () => {
        useTempDataHome("indexed-next-ordinal-");
        const db = openDatabase();
        appendCompartments(db, "ses", [
            {
                sequence: 0,
                startMessage: 1,
                endMessage: 2,
                startMessageId: "m1",
                endMessageId: "m2",
                endBlockIndex: 1,
                title: "indexed",
                content: "indexed",
            },
            {
                sequence: 1,
                startMessage: 3,
                endMessage: 4,
                startMessageId: "m3",
                endMessageId: "m4",
                startBlockIndex: 7,
                title: "next",
                content: "next",
            },
        ]);
        expect(getUncoveredCompartmentEndThrough(db, "ses")).toBeNull();
        db.prepare(
            "UPDATE compartments SET start_message=4 WHERE session_id='ses' AND sequence=1",
        ).run();
        expect(getUncoveredCompartmentEndThrough(db, "ses")).toEqual({
            endMessageId: "m2",
            endMessage: 2,
        });
        db.prepare(
            "UPDATE compartments SET start_message=3, sequence=2 WHERE session_id='ses' AND sequence=1",
        ).run();
        expect(getUncoveredCompartmentEndThrough(db, "ses")).toEqual({
            endMessageId: "m2",
            endMessage: 2,
        });
    });
});

function useTempDataHome(prefix: string): string {
    const dir = createTestTempDirFromPath(join(tmpdir(), prefix));
    tempDirs.push(dir);
    process.env.XDG_DATA_HOME = dir;
    return dir;
}

afterEach(() => {
    closeDatabase();
    for (const dir of tempDirs) {
        try {
            rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
        } catch {
            // Ignore EBUSY on Windows
        }
    }
    tempDirs.length = 0;
    process.env.XDG_DATA_HOME = process.env.MAGIC_CONTEXT_TEST_DATA_DIR;
});

describe("getCompartmentsByEndMessageId (plan v6 §5)", () => {
    test("returns empty array when no compartment has the given endMessageId", () => {
        useTempDataHome("getby-empty-");
        const db = openDatabase();
        const results = getCompartmentsByEndMessageId(db, "ses-1", "msg-missing");
        expect(results).toEqual([]);
    });

    test("returns single match for normal-case lookup", () => {
        useTempDataHome("getby-single-");
        const db = openDatabase();
        appendCompartments(db, "ses-2", [
            {
                sequence: 0,
                startMessage: 0,
                endMessage: 9,
                startMessageId: "msg-start-A",
                endMessageId: "msg-end-A",
                title: "compartment A",
                content: "narrative A",
            },
            {
                sequence: 1,
                startMessage: 10,
                endMessage: 19,
                startMessageId: "msg-start-B",
                endMessageId: "msg-end-B",
                title: "compartment B",
                content: "narrative B",
            },
        ]);
        const results = getCompartmentsByEndMessageId(db, "ses-2", "msg-end-B");
        expect(results.length).toBe(1);
        expect(results[0].sequence).toBe(1);
        expect(results[0].endMessage).toBe(19);
        expect(results[0].title).toBe("compartment B");
    });

    test("session scoping: same endMessageId in different session is invisible", () => {
        useTempDataHome("getby-scope-");
        const db = openDatabase();
        appendCompartments(db, "ses-A", [
            {
                sequence: 0,
                startMessage: 0,
                endMessage: 5,
                startMessageId: "ms",
                endMessageId: "msg-shared",
                title: "A",
                content: "",
            },
        ]);
        appendCompartments(db, "ses-B", [
            {
                sequence: 0,
                startMessage: 0,
                endMessage: 5,
                startMessageId: "ms",
                endMessageId: "msg-shared",
                title: "B",
                content: "",
            },
        ]);
        const a = getCompartmentsByEndMessageId(db, "ses-A", "msg-shared");
        const b = getCompartmentsByEndMessageId(db, "ses-B", "msg-shared");
        expect(a.length).toBe(1);
        expect(b.length).toBe(1);
        expect(a[0].title).toBe("A");
        expect(b[0].title).toBe("B");
    });

    test("returns array (length > 1) when multiple compartments share endMessageId — schema invariant violation case", () => {
        // Schema only enforces UNIQUE(session_id, sequence), NOT (session_id, end_message_id).
        // If a future bug ever leaves two rows sharing a boundary, the marker drain's
        // validatePendingTarget treats length > 1 as a stale-skip. This test simulates
        // that schema violation directly so the defensive code path stays exercised.
        useTempDataHome("getby-dup-");
        const db = openDatabase();
        appendCompartments(db, "ses-dup", [
            {
                sequence: 0,
                startMessage: 0,
                endMessage: 5,
                startMessageId: "s1",
                endMessageId: "msg-dup",
                title: "first",
                content: "",
            },
            {
                sequence: 1,
                startMessage: 6,
                endMessage: 9,
                startMessageId: "s2",
                endMessageId: "msg-dup",
                title: "second",
                content: "",
            },
        ]);
        const results = getCompartmentsByEndMessageId(db, "ses-dup", "msg-dup");
        expect(results.length).toBe(2);
        // ORDER BY sequence ASC — first row is sequence 0
        expect(results[0].sequence).toBe(0);
        expect(results[1].sequence).toBe(1);
    });
});
