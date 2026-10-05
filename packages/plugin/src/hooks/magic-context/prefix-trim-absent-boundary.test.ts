/// <reference types="bun-types" />
import { createTestTempDirFromPath } from "../../shared/test-temp-dir";

/**
 * The m[0]/m[1] prefix trim when the stored compartment boundary is not in the
 * live message array.
 *
 * Reporter shape: a resumed OpenCode session whose loaded window starts after
 * the boundary, so the boundary id never appears in the live array. That is a
 * boundary that sorts before the whole window: there is nothing to cut, and the
 * trim must say so instead of refusing on every pass. A boundary that sorts
 * inside the window but whose row is missing, or a boundary that no longer
 * resolves at all, is a degraded state: the whole window is served on every
 * pass, exactly as before, until a cache-busting pass moves the baseline
 * boundary to a compartment end that is in the window and the id trim applies.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { appendCompartments } from "../../features/magic-context/compartment-storage";
import { getOrCreateSessionMeta } from "../../features/magic-context/storage";
import { initializeDatabase } from "../../features/magic-context/storage-db";
import { Database } from "../../shared/sqlite";
import { closeQuietly } from "../../shared/sqlite-helpers";
import {
    type InjectM0M1Result,
    injectM0M1,
    type M0HardSignals,
    type M0M1State,
    resetPrefixTrimFallbackState,
} from "./inject-compartments";
import { closeReadOnlySessionDb } from "./read-session-db";
import type { MessageLike } from "./tag-messages";

const SESSION_ID = "ses_prefix_trim_absent";
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

const idOf = (index: number): string => `msg_${String(index).padStart(3, "0")}`;
const roleOf = (index: number): "user" | "assistant" => (index % 2 === 1 ? "user" : "assistant");

/** Persist rows 1..count in OpenCode's message table, in canonical order. */
function seedOpenCodeSession(count: number): void {
    const dir = createTestTempDirFromPath(join(tmpdir(), "mc-prefix-trim-absent-"));
    tempDirs.push(dir);
    process.env.XDG_DATA_HOME = dir;
    const path = join(dir, "opencode", "opencode.db");
    mkdirSync(dirname(path), { recursive: true });
    const db = new Database(path);
    try {
        db.exec(`
          CREATE TABLE message (
            id TEXT PRIMARY KEY,
            session_id TEXT NOT NULL,
            time_created INTEGER NOT NULL,
            time_updated INTEGER NOT NULL,
            data TEXT NOT NULL
          );
          CREATE TABLE part (
            id TEXT PRIMARY KEY,
            message_id TEXT NOT NULL,
            session_id TEXT NOT NULL,
            time_created INTEGER NOT NULL,
            time_updated INTEGER NOT NULL,
            data TEXT NOT NULL
          );
        `);
        const insert = db.prepare(
            "INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)",
        );
        for (let index = 1; index <= count; index += 1) {
            insert.run(
                idOf(index),
                SESSION_ID,
                index * 1000,
                index * 1000,
                JSON.stringify({ id: idOf(index), role: roleOf(index), sessionID: SESSION_ID }),
            );
        }
    } finally {
        closeQuietly(db);
    }
}

function contextDb(): Database {
    const db = new Database(":memory:");
    initializeDatabase(db);
    getOrCreateSessionMeta(db, SESSION_ID);
    openDbs.push(db);
    return db;
}

function liveWindow(from: number, to: number, skip: readonly number[] = []): MessageLike[] {
    const messages: MessageLike[] = [];
    for (let index = from; index <= to; index += 1) {
        if (skip.includes(index)) continue;
        messages.push({
            info: { id: idOf(index), role: roleOf(index), sessionID: SESSION_ID },
            parts: [{ type: "text", text: `row ${index}` }],
        });
    }
    return messages;
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
): InjectM0M1Result {
    return injectM0M1({
        db,
        sessionId: SESSION_ID,
        state: getOrCreateSessionMeta(db, SESSION_ID),
        messages,
        preparedPrefix: preparedPrefix(boundary),
        isCacheBustingPass,
    });
}

const ids = (messages: readonly MessageLike[]): Array<string | undefined> =>
    messages.map((message) => message.info.id);
const sha = (messages: readonly MessageLike[]): string =>
    createHash("sha256").update(JSON.stringify(messages)).digest("hex");

describe("prefix trim with a boundary absent from the live window", () => {
    it("treats a resumed window that starts after the boundary as nothing to cut, on every pass", () => {
        // 40 persisted rows; the boundary is row 12; the resumed host window
        // holds only rows 25..40.
        seedOpenCodeSession(40);
        const db = contextDb();
        const boundary = idOf(12);

        const priced = liveWindow(25, 40);
        const pricedResult = servePass(db, priced, boundary, true);
        expect(pricedResult.prefixTrimStatus).toBe("boundary-precedes-window");
        expect(ids(priced)).toEqual([undefined, ...ids(liveWindow(25, 40))]);

        // Priced -> defer: the defer pass over the same window replays the
        // priced bytes exactly.
        const deferSame = liveWindow(25, 40);
        const deferResult = servePass(db, deferSame, boundary, false);
        expect(deferResult.prefixTrimStatus).toBe("boundary-precedes-window");
        expect(sha(deferSame)).toBe(sha(priced));

        // A later defer pass with one more turn keeps the priced bytes as its
        // prefix and only appends.
        seedAppend(41);
        const deferGrown = liveWindow(25, 41);
        servePass(db, deferGrown, boundary, false);
        expect(sha(deferGrown.slice(0, priced.length))).toBe(sha(priced));
        expect(deferGrown).toHaveLength(priced.length + 1);
    });

    it("serves the whole window on every pass when the boundary sorts inside the window but its row is missing", () => {
        // The boundary row 12 sorts inside the window (rows 5..30) but is not
        // in the live array. No pass cuts: the served bytes stay what they were
        // before, and the next baseline refresh is what heals it.
        seedOpenCodeSession(30);
        const db = contextDb();
        const boundary = idOf(12);

        const served: MessageLike[][] = [];
        for (const busting of [false, true, false]) {
            const live = liveWindow(5, 30, [12]);
            expect(servePass(db, live, boundary, busting).prefixTrimStatus).toBe("refused");
            expect(ids(live)).toEqual([undefined, ...ids(liveWindow(5, 30, [12]))]);
            served.push(live);
        }
        expect(new Set(served.map(sha)).size).toBe(1);
    });

    it("serves the whole window when the boundary no longer resolves, even with older compartments that do", () => {
        seedOpenCodeSession(30);
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
                endMessageId: "msg_deleted_boundary",
                title: "second",
                content: "second",
            },
        ]);
        for (const busting of [false, true, false]) {
            const live = liveWindow(1, 30);
            expect(servePass(db, live, "msg_deleted_boundary", busting).prefixTrimStatus).toBe(
                "refused",
            );
            expect(ids(live)).toEqual([undefined, ...ids(liveWindow(1, 30))]);
        }
    });

    it("still refuses, without cutting, when the boundary was never persisted", () => {
        seedOpenCodeSession(20);
        const db = contextDb();
        const boundary = "msg_never_persisted";

        for (const busting of [false, true, false]) {
            const live = liveWindow(1, 20);
            expect(servePass(db, live, boundary, busting).prefixTrimStatus).toBe("refused");
            expect(ids(live)).toEqual([undefined, ...ids(liveWindow(1, 20))]);
        }
    });

    it("does not change a trim whose boundary is in the live array", () => {
        seedOpenCodeSession(20);
        const db = contextDb();
        const live = liveWindow(1, 20);
        expect(servePass(db, live, idOf(6), false).prefixTrimStatus).toBe("applied");
        expect(ids(live)).toEqual([undefined, ...ids(liveWindow(7, 20))]);
    });
});

describe("recovery from a boundary missing inside the window", () => {
    const hardSignals: M0HardSignals = {
        systemHash: "sys-v1",
        modelKey: "anthropic/opus",
        cacheExpired: false,
        lastResponseTime: 0,
    };
    const compartment = (sequence: number, from: number, to: number, body: string) => ({
        sequence,
        startMessage: from,
        endMessage: to,
        startMessageId: idOf(from),
        endMessageId: idOf(to),
        title: body,
        content: body,
        p1: body,
    });

    it("the next cache-busting pass moves the baseline into the window and trims by id", () => {
        seedOpenCodeSession(20);
        const db = contextDb();
        const projectDirectory = createTestTempDirFromPath(
            join(tmpdir(), "mc-prefix-trim-recovery-"),
        );
        tempDirs.push(projectDirectory);
        const run = (messages: MessageLike[], isCacheBustingPass: boolean) =>
            injectM0M1({
                db,
                sessionId: SESSION_ID,
                messages,
                state: getOrCreateSessionMeta(db, SESSION_ID) as unknown as M0M1State,
                projectPath: "/tmp/mc-prefix-trim-recovery",
                projectDirectory,
                historyBudgetTokens: 98_000,
                isCacheBustingPass,
                hardSignals,
            });

        // Baseline: compartment A ends at row 4 and is materialized into m[0]/m[1].
        appendCompartments(db, SESSION_ID, [compartment(1, 1, 4, "Alpha")]);
        const first = liveWindow(1, 20);
        const firstResult = run(first, true);
        expect(firstResult.preparedTrimBoundaryId).toBe(idOf(4));
        expect(firstResult.prefixTrimStatus).toBe("applied");

        // Compartment B (rows 5..10) is published; the baseline still names
        // row 4, and the live array has lost row 4.
        appendCompartments(db, SESSION_ID, [compartment(2, 5, 10, "Bravo")]);
        const degraded = liveWindow(1, 20, [4]);
        const degradedResult = run(degraded, false);
        expect(degradedResult.preparedTrimBoundaryId).toBe(idOf(4));
        expect(degradedResult.prefixTrimStatus).toBe("refused");
        expect(ids(degraded).slice(-19)).toEqual(ids(liveWindow(1, 20, [4])));

        // The next cache-busting pass refreshes m[1] and its baseline to B's end,
        // which is in the window, so the ordinary id trim applies.
        const healed = liveWindow(1, 20, [4]);
        const healedResult = run(healed, true);
        expect(healedResult.preparedTrimBoundaryId).toBe(idOf(10));
        expect(healedResult.prefixTrimStatus).toBe("applied");
        expect(healedResult.m1Text ?? "").toContain("Bravo");
        expect(ids(healed).filter((id) => id !== undefined)).toEqual(ids(liveWindow(11, 20)));
    });
});

function seedAppend(index: number): void {
    const path = join(process.env.XDG_DATA_HOME!, "opencode", "opencode.db");
    closeReadOnlySessionDb();
    const db = new Database(path);
    try {
        db.prepare(
            "INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)",
        ).run(
            idOf(index),
            SESSION_ID,
            index * 1000,
            index * 1000,
            JSON.stringify({ id: idOf(index), role: roleOf(index), sessionID: SESSION_ID }),
        );
    } finally {
        closeQuietly(db);
    }
}
