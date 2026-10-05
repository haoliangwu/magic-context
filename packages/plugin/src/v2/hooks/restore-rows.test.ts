/// <reference types="bun-types" />

import { afterEach, describe, expect, it } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "../../shared/sqlite";
import { createTestTempDirFromPath } from "../../shared/test-temp-dir";
import {
    getV2StoreReaderDebugCounters,
    resetV2StoreReaderDebugCounters,
    V2StoreReader,
} from "../store-reader";
import { RestoredRowCache } from "./restore-rows";

const SESSION = "ses-restore-bounded";
const roots: string[] = [];

afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** A v2 host store holding `count` rows of user turns and assistant/tool arcs. */
function seedStore(count: number): { path: string; store: Database } {
    const root = createTestTempDirFromPath(join(tmpdir(), "mc-v2-restore-bounded-"));
    roots.push(root);
    const path = join(root, "opencode.db");
    const store = new Database(path);
    store.exec(`
        CREATE TABLE session_message(
            id TEXT PRIMARY KEY,
            session_id TEXT NOT NULL,
            type TEXT NOT NULL,
            seq INTEGER NOT NULL,
            time_created INTEGER NOT NULL,
            time_updated INTEGER NOT NULL,
            data TEXT NOT NULL
        );
        CREATE UNIQUE INDEX session_message_session_seq_idx ON session_message(session_id, seq);
        CREATE INDEX session_message_session_type_seq_idx ON session_message(session_id, type, seq);
    `);
    const insert = store.prepare("INSERT INTO session_message VALUES (?, ?, ?, ?, ?, ?, ?)");
    store.transaction(() => {
        for (let seq = 0; seq < count; seq++) insertRow(insert, seq);
    })();
    return { path, store };
}

function insertRow(insert: ReturnType<Database["prepare"]>, seq: number): void {
    const time = 1_800_000_000_000 + seq;
    const user = seq % 3 === 0;
    insert.run(
        `msg-${seq}`,
        SESSION,
        user ? "user" : "assistant",
        seq,
        time,
        time,
        JSON.stringify(
            user
                ? { text: `turn ${seq}`, time: { created: time } }
                : {
                      content: [
                          { type: "text", text: `reply ${seq}` },
                          {
                              type: "tool",
                              callID: `call-${seq}`,
                              name: "read",
                              state: { status: "completed", input: {}, output: `out ${seq}` },
                          },
                      ],
                      model: { providerID: "p", id: "m" },
                  },
        ),
    );
}

/** Rows the restore decoded while running `pass`, and the most any one read decoded. */
function measure<T>(pass: () => T): { value: T; decoded: number; maxPerOperation: number } {
    resetV2StoreReaderDebugCounters();
    const value = pass();
    const counters = getV2StoreReaderDebugCounters();
    return {
        value,
        decoded: counters.decodedRows,
        maxPerOperation: Math.max(
            0,
            ...Object.values(counters.operations).map((operation) => operation.maxDecodedRows),
        ),
    };
}

function fullRange(path: string, after: number, through: number) {
    const reader = new V2StoreReader(path);
    try {
        return reader.range(SESSION, after, through);
    } finally {
        reader.close();
    }
}

/**
 * The OpenCode 2 restore after a host checkpoint with no boundary yet: every pass
 * restores every row before the checkpoint. Returns the decoded-row cost of a pass after
 * the first, with the checkpoint moving forward by a few rows between passes.
 */
function steadyPassCost(rowCount: number): number[] {
    const { path, store } = seedStore(rowCount);
    const insert = store.prepare("INSERT INTO session_message VALUES (?, ?, ?, ?, ?, ?, ?)");
    const cache = new RestoredRowCache();
    let cut = rowCount - 1;
    const costs: number[] = [];
    for (let pass = 0; pass < 4; pass++) {
        const reader = new V2StoreReader(path);
        try {
            const { value, decoded, maxPerOperation } = measure(() =>
                cache.rows(reader, SESSION, -1, cut),
            );
            // No single read decodes more than one page, even on the cold pass.
            expect(maxPerOperation).toBeLessThanOrEqual(100);
            expect(value.length).toBe(cut + 1);
            if (pass > 0) costs.push(decoded);
        } finally {
            reader.close();
        }
        for (let seq = cut + 1; seq <= cut + 6; seq++) insertRow(insert, seq);
        cut += 6;
    }
    store.close();
    return costs;
}

describe("OpenCode 2 restore of rows hidden by a host checkpoint", () => {
    it("decodes a bounded number of rows per pass on a 10,000-row session with no boundary, independent of session length", () => {
        const tenThousand = steadyPassCost(10_000);
        const twentyThousand = steadyPassCost(20_000);
        for (const cost of [...tenThousand, ...twentyThousand])
            expect(cost).toBeLessThanOrEqual(100);
        expect(twentyThousand).toEqual(tenThousand);
    });

    it("returns exactly the rows a full range read returns, as the boundary and checkpoint move", () => {
        const { path, store } = seedStore(2_000);
        const cache = new RestoredRowCache();
        const passes: Array<[number, number]> = [
            [-1, 1_500],
            [-1, 1_500],
            [400, 1_500],
            [400, 1_900],
            [1_950, 1_999],
            [100, 1_999],
        ];
        for (const [after, through] of passes) {
            const reader = new V2StoreReader(path);
            try {
                expect(cache.rows(reader, SESSION, after, through)).toEqual(
                    fullRange(path, after, through),
                );
            } finally {
                reader.close();
            }
        }
        store.close();
    });

    it("rereads a kept span the host rewrote or trimmed inside it", () => {
        const { path, store } = seedStore(500);
        const cache = new RestoredRowCache();
        const read = () => {
            const reader = new V2StoreReader(path);
            try {
                return cache.rows(reader, SESSION, -1, 400);
            } finally {
                reader.close();
            }
        };
        read();
        store
            .prepare("UPDATE session_message SET data = ?, time_updated = ? WHERE id = ?")
            .run(JSON.stringify({ text: "rewritten" }), 1_900_000_000_000, "msg-30");
        expect(read().find((row) => row.id === "msg-30")?.data).toEqual({ text: "rewritten" });
        store.prepare("DELETE FROM session_message WHERE seq > 200 AND seq <= 250").run();
        expect(read()).toEqual(fullRange(path, -1, 400));
        store.close();
    });

    it("rereads a row rewritten in place without a new update time, and only that row", () => {
        const { path, store } = seedStore(500);
        const cache = new RestoredRowCache();
        const read = () => {
            const reader = new V2StoreReader(path);
            try {
                return measure(() => cache.rows(reader, SESSION, -1, 400));
            } finally {
                reader.close();
            }
        };
        read();
        // The host rewrites a finished row in place (a tool part's state settling, say)
        // through its own update, and nothing guarantees time_updated moves with it.
        const before = store
            .prepare("SELECT data, time_updated FROM session_message WHERE id = ?")
            .get("msg-31") as { data: string; time_updated: number };
        const rewritten = JSON.parse(before.data) as { content: Array<Record<string, unknown>> };
        const tool = rewritten.content.find((part) => part.type === "tool")!;
        tool.state = { status: "completed", input: {}, output: "rewritten output" };
        store
            .prepare("UPDATE session_message SET data = ? WHERE id = ?")
            .run(JSON.stringify(rewritten), "msg-31");
        const after = store
            .prepare("SELECT time_updated FROM session_message WHERE id = ?")
            .get("msg-31") as { time_updated: number };
        expect(after.time_updated).toBe(before.time_updated);

        const refreshed = read();
        expect(refreshed.value).toEqual(fullRange(path, -1, 400));
        // One changed row, one row decoded.
        expect(refreshed.decoded).toBe(1);
        // A time_updated bump at the same size is caught too.
        store
            .prepare("UPDATE session_message SET time_updated = time_updated + 1 WHERE id = ?")
            .run("msg-60");
        expect(read().decoded).toBe(1);
        store.close();
    });

    it("costs one undecoded stamp read per pass on a 10,000-row span", () => {
        const { path, store } = seedStore(10_000);
        const cache = new RestoredRowCache();
        const reader = new V2StoreReader(path);
        try {
            cache.rows(reader, SESSION, -1, 9_999);
            const timings: number[] = [];
            for (let pass = 0; pass < 5; pass++) {
                const started = performance.now();
                const { decoded } = measure(() => cache.rows(reader, SESSION, -1, 9_999));
                timings.push(performance.now() - started);
                expect(decoded).toBe(0);
            }
            console.log(
                `steady restore pass over 10,000 rows (stamps plus copy): ${timings.map((ms) => ms.toFixed(1)).join(" ")} ms`,
            );
        } finally {
            reader.close();
            store.close();
        }
    });

    it("hands each pass its own copy, so the transform editing restored rows cannot leak into the next pass", () => {
        const { path, store } = seedStore(50);
        const cache = new RestoredRowCache();
        const reader = new V2StoreReader(path);
        try {
            const first = cache.rows(reader, SESSION, -1, 40);
            (first[0]!.data as { text?: string }).text = "edited by a pass";
            expect(cache.rows(reader, SESSION, -1, 40)[0]!.data).toEqual(
                fullRange(path, -1, 40)[0]!.data,
            );
        } finally {
            reader.close();
            store.close();
        }
    });
});
