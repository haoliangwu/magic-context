import { expect, test } from "bun:test";
import { Database } from "../../shared/sqlite";
import { copySessionStateForClone } from "./storage-clone";
import { initializeDatabase } from "./storage-db";
import {
    addProcessedImageStrippedIds,
    getProcessedImageMarkers,
    getProcessedImageStrippedIds,
    loadPostprocessReplaySnapshot,
} from "./storage-meta-persisted";

test("issue 699 marker persistence preserves legacy arrays and first-writer marker decisions", () => {
    const db = new Database(":memory:");
    try {
        initializeDatabase(db);
        expect(addProcessedImageStrippedIds(db, "s", ["empty"])).toBe(true);
        const blob = () =>
            (
                db
                    .prepare(
                        "SELECT processed_image_stripped_ids AS value FROM session_meta WHERE session_id = 's'",
                    )
                    .get() as { value: string }
            ).value;
        expect(blob()).toBe('["empty"]');
        expect(addProcessedImageStrippedIds(db, "s", ["text", "empty"], "[image stripped]")).toBe(
            true,
        );
        expect(addProcessedImageStrippedIds(db, "s", ["text"], "")).toBe(true);
        expect([...getProcessedImageMarkers(db, "s")]).toEqual([
            ["empty", ""],
            ["text", "[image stripped]"],
        ]);
        expect([...getProcessedImageStrippedIds(db, "s")]).toEqual(["empty", "text"]);
        expect([...loadPostprocessReplaySnapshot(db, "s").processedImageMarkers]).toEqual([
            ["empty", ""],
            ["text", "[image stripped]"],
        ]);
        expect(JSON.parse(blob())).toEqual({ ids: ["empty", "text"], textMarkerIds: ["text"] });
    } finally {
        db.close();
    }
});

test("issue 699 cloned image freezes retain marker forms while filtering and remapping ids", () => {
    const db = new Database(":memory:");
    try {
        initializeDatabase(db);
        addProcessedImageStrippedIds(db, "parent", ["empty"]);
        addProcessedImageStrippedIds(db, "parent", ["text", "excluded"], "[image stripped]");
        const result = copySessionStateForClone(db, "parent", "child", {
            includeMessageId: (id) => id !== "excluded",
            mapMessageId: (id) => `copy-${id}`,
            includeTag: () => true,
            resolveBoundaryOrdinal: () => 0,
            selectPendingPiMarker: () => null,
        });
        expect(result.kind).toBe("migrated");
        expect([...getProcessedImageMarkers(db, "child")]).toEqual([
            ["copy-empty", ""],
            ["copy-text", "[image stripped]"],
        ]);
    } finally {
        db.close();
    }
});
