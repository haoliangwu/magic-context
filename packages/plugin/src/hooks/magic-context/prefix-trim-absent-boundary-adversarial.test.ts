/// <reference types="bun-types" />
import { createTestTempDirFromPath } from "../../shared/test-temp-dir";

/**
 * Adversarial checks for the prefix trim when the stored compartment boundary
 * is not in the live message array.
 *
 * The protected cache rule under test: a defer pass (not cache-busting) must
 * serve bytes whose prefix is byte-identical to what the last served pass sent.
 * A missing boundary never cuts, so every pass serves the whole window, the same
 * bytes as before the absent-boundary classification existed; the shapes below
 * (host rows deleted or inserted, a revert, a restart, OpenCode's compaction
 * reorder) are the ones an ordinal-based cut got wrong.
 */

import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { appendCompartments } from "../../features/magic-context/compartment-storage";
import { getOrCreateSessionMeta } from "../../features/magic-context/storage";
import { initializeDatabase } from "../../features/magic-context/storage-db";
import * as loggerModule from "../../shared/logger";
import { Database } from "../../shared/sqlite";
import { closeQuietly } from "../../shared/sqlite-helpers";
import {
    type InjectM0M1Result,
    injectM0M1,
    type PrefixTrimSourceOrder,
    resetPrefixTrimFallbackState,
} from "./inject-compartments";
import { closeReadOnlySessionDb } from "./read-session-db";
import type { MessageLike } from "./tag-messages";

const SESSION_ID = "ses_prefix_trim_adversarial";
const originalXdgDataHome = process.env.XDG_DATA_HOME;
const tempDirs: string[] = [];
const openDbs: Database[] = [];

afterEach(() => {
    closeReadOnlySessionDb();
    resetPrefixTrimFallbackState(SESSION_ID);
    for (const db of openDbs.splice(0)) closeQuietly(db);
    if (originalXdgDataHome === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = originalXdgDataHome;
    for (const dir of tempDirs.splice(0)) {
        rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
});

const idOf = (index: number): string => `msg_${String(index).padStart(6, "0")}`;
const roleOf = (index: number): "user" | "assistant" => (index % 2 === 1 ? "user" : "assistant");

interface SeedRow {
    id: string;
    time: number;
    info: Record<string, unknown>;
}

function regularRow(index: number, time = index * 1000): SeedRow {
    return {
        id: idOf(index),
        time,
        info: { id: idOf(index), role: roleOf(index), sessionID: SESSION_ID },
    };
}

function openCodeDbPath(): string {
    return join(process.env.XDG_DATA_HOME!, "opencode", "opencode.db");
}

/** Create a throwaway OpenCode store under a fresh XDG_DATA_HOME. */
function createOpenCodeStore(rows: readonly SeedRow[]): void {
    const dir = createTestTempDirFromPath(join(tmpdir(), "mc-prefix-trim-adversarial-"));
    tempDirs.push(dir);
    process.env.XDG_DATA_HOME = dir;
    mkdirSync(dirname(openCodeDbPath()), { recursive: true });
    const db = new Database(openCodeDbPath());
    try {
        db.exec(`
          CREATE TABLE message (
            id TEXT PRIMARY KEY,
            session_id TEXT NOT NULL,
            time_created INTEGER NOT NULL,
            time_updated INTEGER NOT NULL,
            data TEXT NOT NULL
          );
          CREATE INDEX message_session_idx ON message(session_id, time_created, id);
          CREATE TABLE part (
            id TEXT PRIMARY KEY,
            message_id TEXT NOT NULL,
            session_id TEXT NOT NULL,
            time_created INTEGER NOT NULL,
            time_updated INTEGER NOT NULL,
            data TEXT NOT NULL
          );
        `);
    } finally {
        closeQuietly(db);
    }
    insertRows(rows);
}

/** Write to the host store the way the host does, outside MC's read-only handle. */
function mutateOpenCodeStore(fn: (db: Database) => void): void {
    closeReadOnlySessionDb();
    const db = new Database(openCodeDbPath());
    try {
        db.exec("BEGIN");
        fn(db);
        db.exec("COMMIT");
    } finally {
        closeQuietly(db);
    }
}

function insertRows(rows: readonly SeedRow[]): void {
    mutateOpenCodeStore((db) => {
        const insert = db.prepare(
            "INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)",
        );
        for (const row of rows) {
            insert.run(row.id, SESSION_ID, row.time, row.time, JSON.stringify(row.info));
        }
    });
}

function deleteRows(ids: readonly string[]): void {
    mutateOpenCodeStore((db) => {
        const remove = db.prepare("DELETE FROM message WHERE session_id = ? AND id = ?");
        for (const id of ids) remove.run(SESSION_ID, id);
    });
}

function range(from: number, to: number): number[] {
    return Array.from({ length: to - from + 1 }, (_, offset) => from + offset);
}

function contextDb(): Database {
    const db = new Database(":memory:");
    initializeDatabase(db);
    getOrCreateSessionMeta(db, SESSION_ID);
    openDbs.push(db);
    return db;
}

function liveRow(id: string, role: string, text: string): MessageLike {
    return {
        info: { id, role, sessionID: SESSION_ID },
        parts: [{ type: "text", text }],
    } as MessageLike;
}

/** OpenCode serves its compaction summary with `summary: true` on the message info. */
function hostSummaryRow(id: string): MessageLike {
    return {
        info: { id, role: "assistant", sessionID: SESSION_ID, summary: true, finish: "stop" },
        parts: [{ type: "text", text: "host summary of rows 1..9" }],
    } as MessageLike;
}

function liveWindow(indexes: readonly number[]): MessageLike[] {
    return indexes.map((index) => liveRow(idOf(index), roleOf(index), `row ${index}`));
}

function preparedPrefix(boundary: string): InjectM0M1Result {
    return {
        injected: true,
        prependedMessageCount: 0,
        m0RematerializedThisPass: false,
        materializationContentionRetryExhausted: false,
        decision: { value: false, reason: "cache_hit" },
        m0Bytes: Buffer.from("m0"),
        m1Text: "m1",
        preparedMessages: [
            {
                info: { role: "user", sessionID: SESSION_ID },
                parts: [{ type: "text", text: "summary prefix", synthetic: true }],
            } as MessageLike,
        ],
        preparedTrimBoundaryId: boundary,
    };
}

function servePass(
    db: Database,
    messages: MessageLike[],
    boundary: string,
    isCacheBustingPass: boolean,
    prefixTrimSourceOrder?: PrefixTrimSourceOrder,
): InjectM0M1Result {
    return injectM0M1({
        db,
        sessionId: SESSION_ID,
        state: getOrCreateSessionMeta(db, SESSION_ID),
        messages,
        preparedPrefix: preparedPrefix(boundary),
        isCacheBustingPass,
        prefixTrimSourceOrder,
    });
}

const ids = (messages: readonly MessageLike[]): Array<string | undefined> =>
    messages.map((message) => message.info.id);
const sha = (messages: readonly MessageLike[]): string =>
    createHash("sha256").update(JSON.stringify(messages)).digest("hex");

/** Priced pass A, one appended turn, defer pass B: B must start with A's exact bytes. */
function expectAppendOnlyDefer(served: MessageLike[], deferPass: MessageLike[]): void {
    expect(deferPass.length).toBe(served.length + 1);
    expect(sha(deferPass.slice(0, served.length))).toBe(sha(served));
}

describe("absent-boundary prefix trim: append-only defer passes keep the priced prefix", () => {
    it("boundary-precedes-window: priced A, append, defer B", () => {
        createOpenCodeStore(range(1, 40).map((index) => regularRow(index)));
        const db = contextDb();
        const boundary = idOf(12);
        const priced = liveWindow(range(25, 40));
        expect(servePass(db, priced, boundary, true).prefixTrimStatus).toBe(
            "boundary-precedes-window",
        );
        insertRows([regularRow(41)]);
        const defer = liveWindow(range(25, 41));
        expect(servePass(db, defer, boundary, false).prefixTrimStatus).toBe(
            "boundary-precedes-window",
        );
        expectAppendOnlyDefer(priced, defer);
    });

    it("boundary sorts inside the window, row missing: priced A, append, defer B", () => {
        createOpenCodeStore(range(1, 30).map((index) => regularRow(index)));
        const db = contextDb();
        const boundary = idOf(12);
        const window = (to: number) => liveWindow(range(5, to).filter((index) => index !== 12));
        const priced = window(30);
        expect(servePass(db, priced, boundary, true).prefixTrimStatus).toBe("refused");
        expect(ids(priced)).toEqual([undefined, ...ids(window(30))]);
        insertRows([regularRow(31)]);
        const defer = window(31);
        expect(servePass(db, defer, boundary, false).prefixTrimStatus).toBe("refused");
        expectAppendOnlyDefer(priced, defer);
    });

    it("boundary no longer resolves, older compartment end does: priced A, append, defer B", () => {
        createOpenCodeStore(range(1, 30).map((index) => regularRow(index)));
        const db = contextDb();
        appendCompartments(db, SESSION_ID, [
            {
                sequence: 1,
                startMessage: 1,
                endMessage: 8,
                startMessageId: idOf(1),
                endMessageId: idOf(8),
                title: "first",
                content: "first",
            },
            {
                sequence: 2,
                startMessage: 9,
                endMessage: 14,
                startMessageId: idOf(9),
                endMessageId: "msg_gone",
                title: "second",
                content: "second",
            },
        ]);
        const priced = liveWindow(range(1, 30));
        expect(servePass(db, priced, "msg_gone", true).prefixTrimStatus).toBe("refused");
        expect(ids(priced)).toEqual([undefined, ...ids(liveWindow(range(1, 30)))]);
        insertRows([regularRow(31)]);
        const defer = liveWindow(range(1, 31));
        expect(servePass(db, defer, "msg_gone", false).prefixTrimStatus).toBe("refused");
        expectAppendOnlyDefer(priced, defer);
    });

    it("refused (nothing resolves): priced A, append, defer B", () => {
        createOpenCodeStore(range(1, 20).map((index) => regularRow(index)));
        const db = contextDb();
        const priced = liveWindow(range(1, 20));
        expect(servePass(db, priced, "msg_never", true).prefixTrimStatus).toBe("refused");
        insertRows([regularRow(21)]);
        const defer = liveWindow(range(1, 21));
        expect(servePass(db, defer, "msg_never", false).prefixTrimStatus).toBe("refused");
        expectAppendOnlyDefer(priced, defer);
    });

    it("degraded before any bust: defer A, append, defer B", () => {
        createOpenCodeStore(range(1, 30).map((index) => regularRow(index)));
        const db = contextDb();
        const boundary = idOf(12);
        const window = (to: number) => liveWindow(range(5, to).filter((index) => index !== 12));
        const first = window(30);
        expect(servePass(db, first, boundary, false).prefixTrimStatus).toBe("refused");
        insertRows([regularRow(31)]);
        const second = window(31);
        expect(servePass(db, second, boundary, false).prefixTrimStatus).toBe("refused");
        expectAppendOnlyDefer(first, second);
    });
});

describe("absent-boundary prefix trim: the log does not imply the host window started after the boundary", () => {
    // Production shape: compartment injection already cut the window through the
    // boundary (row 12), then reduction removed rows 13-14 (tool-only steps whose
    // calls were dropped), so the first remaining row is 15. OpenCode served 13-14.
    it("says the rows between were cut or removed this pass, and serves the same rows as before", () => {
        // The line is logged once per boundary per process; start fresh.
        resetPrefixTrimFallbackState(SESSION_ID);
        createOpenCodeStore(range(1, 30).map((index) => regularRow(index)));
        const db = contextDb();
        const lines: string[] = [];
        const spy = spyOn(loggerModule, "sessionLog").mockImplementation((_id, ...values) => {
            lines.push(values.map(String).join(" "));
        });
        try {
            const live = liveWindow(range(15, 30));
            const status = injectM0M1({
                db,
                sessionId: SESSION_ID,
                state: getOrCreateSessionMeta(db, SESSION_ID),
                messages: live,
                preparedPrefix: preparedPrefix(idOf(12)),
                isCacheBustingPass: true,
            }).prefixTrimStatus;

            expect(status).toBe("boundary-precedes-window");
            expect(ids(live)).toEqual([undefined, ...ids(liveWindow(range(15, 30)))]);
            expect(lines.filter((line) => line.includes("prefix trim:"))).toEqual([
                `prefix trim: boundary ${idOf(12)} precedes the first remaining message ${idOf(15)}; rows between were cut with the summarized history or removed by reduction this pass; pass=priced; nothing to cut`,
            ]);
        } finally {
            spy.mockRestore();
        }
    });
});

describe("absent-boundary prefix trim: host changes between a priced and a defer pass", () => {
    // With no cut there is nothing for a change to host rows, a revert or a
    // restart to move: each defer pass serves the priced bytes.
    it("a host row deleted before the boundary does not change the defer bytes", () => {
        createOpenCodeStore(range(1, 30).map((index) => regularRow(index)));
        const db = contextDb();
        const boundary = idOf(12);
        const window = () => liveWindow(range(5, 30).filter((index) => index !== 12));
        const priced = window();
        servePass(db, priced, boundary, true);
        expect(ids(priced)).toEqual([undefined, ...ids(window())]);

        deleteRows([idOf(3)]);
        const defer = window();
        servePass(db, defer, boundary, false);
        expect(sha(defer)).toBe(sha(priced));
    });

    it("host rows inserted before the boundary do not change the defer bytes", () => {
        createOpenCodeStore(range(1, 30).map((index) => regularRow(index)));
        const db = contextDb();
        const boundary = idOf(12);
        const window = () => liveWindow(range(5, 30).filter((index) => index !== 12));
        const priced = window();
        servePass(db, priced, boundary, true);

        // Two rows that sort early in the host's (time_created, id) order, as an
        // imported or backfilled row would.
        insertRows([
            { id: "msg_early_a", time: 500, info: { id: "msg_early_a", role: "user" } },
            { id: "msg_early_b", time: 600, info: { id: "msg_early_b", role: "assistant" } },
        ]);
        const defer = window();
        servePass(db, defer, boundary, false);
        expect(sha(defer)).toBe(sha(priced));
    });

    it("after a revert past the boundary, a defer pass keeps the new user turn", () => {
        createOpenCodeStore(range(1, 30).map((index) => regularRow(index)));
        const db = contextDb();
        const boundary = idOf(12);
        const priced = liveWindow(range(5, 30).filter((index) => index !== 12));
        servePass(db, priced, boundary, true);

        // Revert to row 8: the host deletes rows 9..30 (including the boundary
        // row, which MC's compartments still name) and the user sends a new
        // turn. The plugin's message.removed handler does not clear the stored
        // compartments, so the next defer pass still carries boundary msg 12.
        deleteRows(range(9, 30).map(idOf));
        insertRows([
            { id: "msg_new_user", time: 40_000, info: { id: "msg_new_user", role: "user" } },
        ]);
        const defer = [
            ...liveWindow(range(5, 8)),
            liveRow("msg_new_user", "user", "the user's new prompt"),
        ];
        servePass(db, defer, boundary, false);
        expect(ids(defer)).toEqual([undefined, ...ids(liveWindow(range(5, 8))), "msg_new_user"]);
    });

    // `resetPrefixTrimFallbackState` clears the same module-level maps a process
    // restart starts without.
    it("a defer pass after a restart serves the bytes the last busting pass served", () => {
        createOpenCodeStore(range(1, 30).map((index) => regularRow(index)));
        const db = contextDb();
        const boundary = idOf(12);
        const window = () => liveWindow(range(5, 30).filter((index) => index !== 12));
        const priced = window();
        expect(servePass(db, priced, boundary, true).prefixTrimStatus).toBe("refused");

        resetPrefixTrimFallbackState(SESSION_ID);
        const defer = window();
        servePass(db, defer, boundary, false);
        expect(sha(defer)).toBe(sha(priced));
    });
});

describe("absent-boundary prefix trim: OpenCode 1.18 filterCompacted reorder", () => {
    // filterCompacted returns [compaction user, summary, retained tail, rest]
    // when a compaction part carries tail_start_id, so the compaction user row
    // (newer than the tail) sits before older tail rows in the array.
    it("keeps the host compaction user row and summary when the boundary sorts inside the retained tail", () => {
        const rows = range(1, 20).map((index) => regularRow(index));
        const compactionUser: SeedRow = {
            id: "msg_000021c",
            time: 21_000,
            info: { id: "msg_000021c", role: "user", sessionID: SESSION_ID },
        };
        const summary: SeedRow = {
            id: "msg_000022s",
            time: 22_000,
            info: {
                id: "msg_000022s",
                role: "assistant",
                summary: true,
                finish: "stop",
                parentID: "msg_000021c",
                sessionID: SESSION_ID,
            },
        };
        const rest = range(23, 26).map((index) => regularRow(index));
        createOpenCodeStore([...rows, compactionUser, summary, ...rest]);
        const db = contextDb();
        const boundary = idOf(15);

        const reordered = [
            {
                info: { id: compactionUser.id, role: "user", sessionID: SESSION_ID },
                parts: [{ type: "compaction", auto: true, tail_start_id: idOf(10) }],
            } as MessageLike,
            hostSummaryRow(summary.id),
            ...liveWindow(range(10, 20).filter((index) => index !== 15)),
            ...liveWindow(range(23, 26)),
        ];
        const before = ids(reordered);
        // The compaction request row sorts after the boundary, but the retained
        // tail it heads does not, so this is not a window that starts past the
        // boundary; nothing is cut either way.
        expect(servePass(db, reordered, boundary, true).prefixTrimStatus).toBe("refused");
        expect(ids(reordered)).toEqual([undefined, ...before]);
    });

    it("keeps the reordered window whole when the boundary sorts before the retained tail", () => {
        const rows = range(1, 20).map((index) => regularRow(index));
        const compactionUser: SeedRow = {
            id: "msg_000021c",
            time: 21_000,
            info: { id: "msg_000021c", role: "user", sessionID: SESSION_ID },
        };
        const summary: SeedRow = {
            id: "msg_000022s",
            time: 22_000,
            info: {
                id: "msg_000022s",
                role: "assistant",
                summary: true,
                finish: "stop",
                parentID: "msg_000021c",
                sessionID: SESSION_ID,
            },
        };
        createOpenCodeStore([...rows, compactionUser, summary, regularRow(23)]);
        const db = contextDb();
        const reordered = [
            {
                info: { id: compactionUser.id, role: "user", sessionID: SESSION_ID },
                parts: [{ type: "compaction", auto: true, tail_start_id: idOf(10) }],
            } as MessageLike,
            hostSummaryRow(summary.id),
            ...liveWindow(range(10, 20)),
            ...liveWindow([23]),
        ];
        const before = ids(reordered);
        expect(servePass(db, reordered, idOf(6), true).prefixTrimStatus).toBe(
            "boundary-precedes-window",
        );
        expect(ids(reordered)).toEqual([undefined, ...before]);
    });
});

describe("absent-boundary prefix trim: source-order branch", () => {
    function sourceOrderFor(messages: readonly MessageLike[]): PrefixTrimSourceOrder {
        return {
            messageIds: messages.map((message) => message.info.id as string),
            syntheticHeadCount: 0,
            invalidReason: null,
        };
    }

    it("keeps master's refusal: the whole window on defer and busting passes", () => {
        createOpenCodeStore(range(1, 30).map((index) => regularRow(index)));
        const db = contextDb();
        const boundary = idOf(12);
        const window = (to: number) => liveWindow(range(5, to).filter((index) => index !== 12));

        const deferFirst = window(30);
        const deferFirstOrder = sourceOrderFor(deferFirst);
        expect(servePass(db, deferFirst, boundary, false, deferFirstOrder).prefixTrimStatus).toBe(
            "refused",
        );
        expect(ids(deferFirst)).toEqual([undefined, ...ids(window(30))]);

        const priced = window(30);
        expect(servePass(db, priced, boundary, true, sourceOrderFor(priced)).prefixTrimStatus).toBe(
            "refused",
        );
        expect(ids(priced)).toEqual([undefined, ...ids(window(30))]);

        insertRows([regularRow(31)]);
        const defer = window(31);
        expect(servePass(db, defer, boundary, false, sourceOrderFor(defer)).prefixTrimStatus).toBe(
            "refused",
        );
        expectAppendOnlyDefer(priced, defer);
    });
});

// Cost probe for the absent-boundary state on a long session. Opt-in because it
// seeds a large store: MC_538_COST_ROWS=135000 bun test <this file>.
const costRows = Number(process.env.MC_538_COST_ROWS ?? "0");
describe.skipIf(!(costRows > 0))("absent-boundary prefix trim: per-pass cost", () => {
    it("reports the time of precedes-window and degraded passes", () => {
        const rows: SeedRow[] = [];
        for (let index = 1; index <= costRows; index += 1) {
            const row = regularRow(index);
            // Real host rows carry a few hundred bytes of JSON metadata.
            row.info = {
                ...row.info,
                time: { created: index * 1000, completed: index * 1000 + 500 },
                modelID: "claude-sonnet-4-5",
                providerID: "anthropic",
                path: { cwd: "/some/project/path", root: "/some/project/path" },
                tokens: { input: 1234, output: 567, cache: { read: 89012, write: 345 } },
            };
            rows.push(row);
        }
        createOpenCodeStore(rows);
        const db = contextDb();
        const tail = range(costRows - 99, costRows);

        const time = (label: string, run: () => void): number => {
            const started = performance.now();
            run();
            const elapsed = performance.now() - started;
            console.log(`[538 cost] rows=${costRows} ${label}: ${elapsed.toFixed(1)}ms`);
            return elapsed;
        };

        // Reporter shape: the loaded window starts after the boundary.
        const precedesBoundary = idOf(Math.floor(costRows * 0.8));
        for (let pass = 0; pass < 3; pass += 1) {
            time(`precedes-window pass ${pass}`, () => {
                const live = liveWindow(tail);
                expect(servePass(db, live, precedesBoundary, false).prefixTrimStatus).toBe(
                    "boundary-precedes-window",
                );
            });
        }

        // Degraded shape: the boundary sorts inside the window but its row is
        // missing. No cut; the first pass places the boundary, later passes
        // reuse that verdict.
        const insideIndex = costRows - 50;
        const insideBoundary = idOf(insideIndex);
        const degradedWindow = () => liveWindow(tail.filter((index) => index !== insideIndex));
        time("degraded busting pass", () => {
            expect(servePass(db, degradedWindow(), insideBoundary, true).prefixTrimStatus).toBe(
                "refused",
            );
        });
        for (let pass = 0; pass < 3; pass += 1) {
            time(`degraded defer pass ${pass}`, () => {
                expect(
                    servePass(db, degradedWindow(), insideBoundary, false).prefixTrimStatus,
                ).toBe("refused");
            });
        }

        // Control: the boundary found by id costs no store read at all.
        time("boundary found by id", () => {
            const live = liveWindow(tail);
            expect(servePass(db, live, idOf(costRows - 50), false).prefixTrimStatus).toBe(
                "applied",
            );
        });
    }, 600_000);
});
