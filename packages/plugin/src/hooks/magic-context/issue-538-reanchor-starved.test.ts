/// <reference types="bun-types" />
import { createTestTempDirFromPath } from "../../shared/test-temp-dir";

/**
 * Reproductions for the issue 538 follow-up report: a warm-cache session whose
 * historian keeps publishing while the history baseline never moves, which the
 * reporter read as "the re-anchor recovery is unreachable in warm-cache use".
 * These tests pin current behaviour; they do not change it. Each one drives the two history paths in the order transform
 * runs them on one pass:
 *
 *   1. transform.ts calls prepareCompartmentInjection(messages, ...), which cuts
 *      the covered raw rows out of `messages` in place;
 *   2. postprocess calls injectM0M1({ messages }) on the SAME array, whose prefix
 *      trim looks for the persisted baseline boundary again.
 *
 * Findings pinned here:
 *   - When the injection path finds the boundary, the prefix trim then reports
 *     "boundary-precedes-window". That is not a disagreement between the two
 *     paths: the trim reads the array after the first path already cut it, so
 *     the first live row is the row right after the boundary.
 *   - Raw rows covered by a compartment published after the baseline stay on
 *     the wire on every defer pass, and a cache-busting pass moves the baseline
 *     and cuts them.
 *   - The degraded-pass count that gates the re-anchor is reset by the cache
 *     clear every cache-busting pass performs, but defer passes do advance it
 *     while the boundary is absent.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { appendCompartments } from "../../features/magic-context/compartment-storage";
import { getOrCreateSessionMeta } from "../../features/magic-context/storage";
import { initializeDatabase } from "../../features/magic-context/storage-db";
import { Database } from "../../shared/sqlite";
import { closeQuietly } from "../../shared/sqlite-helpers";
import {
    clearInjectionCache,
    type InjectM0M1Result,
    injectM0M1,
    type M0HardSignals,
    type M0M1State,
    prepareCompartmentInjection,
    resetPrefixTrimFallbackState,
} from "./inject-compartments";
import { closeReadOnlySessionDb } from "./read-session-db";
import type { MessageLike } from "./tag-messages";

const SESSION_ID = "ses_issue538_reanchor";
const originalXdgDataHome = process.env.XDG_DATA_HOME;
const tempDirs: string[] = [];
const openDbs: Database[] = [];

afterEach(() => {
    closeReadOnlySessionDb();
    clearInjectionCache(SESSION_ID);
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

/** Persist rows 1..count in a throwaway OpenCode message table, in canonical order. */
function seedOpenCodeSession(count: number): void {
    const dir = createTestTempDirFromPath(join(tmpdir(), "mc-issue538-"));
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

const persistedIds = (messages: readonly MessageLike[]): string[] =>
    messages.map((message) => message.info.id).filter((id): id is string => id !== undefined);

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

describe("issue 538 claim 3: the two paths read one array in sequence", () => {
    const hardSignals: M0HardSignals = {
        systemHash: "sys-v1",
        modelKey: "anthropic/opus",
        cacheExpired: false,
        lastResponseTime: 0,
    };

    it("injection finds the baseline boundary and cuts; the prefix trim then sees it before the window", () => {
        seedOpenCodeSession(20);
        const db = contextDb();
        const projectDirectory = createTestTempDirFromPath(join(tmpdir(), "mc-issue538-project-"));
        tempDirs.push(projectDirectory);

        // One transform pass in production order: injection preparation first,
        // then m[0]/m[1] delivery on the same, already-cut array.
        const pass = (messages: MessageLike[], isCacheBusting: boolean) => {
            const prepared = prepareCompartmentInjection(db, SESSION_ID, messages, isCacheBusting);
            const delivered = injectM0M1({
                db,
                sessionId: SESSION_ID,
                messages,
                state: getOrCreateSessionMeta(db, SESSION_ID) as unknown as M0M1State,
                projectPath: "/tmp/mc-issue538",
                projectDirectory,
                historyBudgetTokens: 98_000,
                isCacheBustingPass: isCacheBusting,
                hardSignals,
            });
            return { prepared, delivered };
        };

        // Baseline: compartment A (rows 1..4) is materialized on a busting pass.
        appendCompartments(db, SESSION_ID, [compartment(1, 1, 4, "Alpha")]);
        const first = pass(liveWindow(1, 20), true);
        expect(first.delivered.preparedTrimBoundaryId).toBe(idOf(4));

        // The historian publishes compartment B (rows 5..10). Warm-cache defer
        // passes follow; the baseline boundary stays at row 4.
        appendCompartments(db, SESSION_ID, [compartment(2, 5, 10, "Bravo")]);
        for (let defer = 0; defer < 3; defer += 1) {
            const live = liveWindow(1, 20);
            const { prepared, delivered } = pass(live, false);

            // The injection path FOUND the boundary (normal splice, not the
            // degraded branch): it cut rows 1..4 and kept row 4 as its boundary.
            expect(prepared?.compartmentEndMessageId).toBe(idOf(4));
            expect(prepared?.skippedVisibleMessages).toBe(4);

            // The prefix trim looked for the same boundary in the same array,
            // after that cut, so it reports the boundary as before the window.
            expect(delivered.preparedTrimBoundaryId).toBe(idOf(4));
            expect(delivered.prefixTrimStatus).toBe("boundary-precedes-window");

            // Rows 5..10 are summarized by compartment B yet still go out raw:
            // the frozen-baseline state. Nothing on a defer pass moves it.
            expect(persistedIds(live)).toEqual(persistedIds(liveWindow(5, 20)));
        }

        // Control: the prefix trim on the array BEFORE the injection cut applies
        // the id trim, so the verdict depends only on which array it reads.
        const uncut = liveWindow(1, 20);
        const direct = injectM0M1({
            db,
            sessionId: SESSION_ID,
            messages: uncut,
            state: getOrCreateSessionMeta(db, SESSION_ID) as unknown as M0M1State,
            projectPath: "/tmp/mc-issue538",
            projectDirectory,
            historyBudgetTokens: 98_000,
            isCacheBustingPass: false,
            hardSignals,
        });
        expect(direct.prefixTrimStatus).toBe("applied");

        // The designed recovery: one cache-busting pass moves the baseline to
        // compartment B's end and the raw rows it covers leave the wire.
        const busting = liveWindow(1, 20);
        const healed = pass(busting, true);
        expect(healed.delivered.preparedTrimBoundaryId).toBe(idOf(10));
        expect(persistedIds(busting)).toEqual(persistedIds(liveWindow(11, 20)));
    });
});

describe("issue 538 claim 1: the degraded-pass count that gates the re-anchor", () => {
    // No m[0] has been persisted for this session, so the injection boundary is
    // simply the latest compartment end, row 12, which the live window lacks. Compartment 1 ends
    // at row 4, which is live, so it is the only possible re-anchor target.
    function seedDegraded(): Database {
        seedOpenCodeSession(30);
        const db = contextDb();
        appendCompartments(db, SESSION_ID, [
            compartment(1, 1, 4, "Alpha"),
            compartment(2, 5, 12, "Bravo"),
        ]);
        return db;
    }
    const window = () => liveWindow(1, 30, [12]);
    const reanchored = (result: ReturnType<typeof prepareCompartmentInjection>) =>
        result?.compartmentEndMessageId === idOf(4);

    function bustingDelivery(db: Database, messages: MessageLike[]): void {
        const preparedPrefix: InjectM0M1Result = {
            injected: true,
            prependedMessageCount: 0,
            m0RematerializedThisPass: false,
            materializationContentionRetryExhausted: false,
            decision: { value: false, reason: "cache_hit" },
            m0Bytes: Buffer.from("m0"),
            m1Text: "m1",
            preparedMessages: [],
            preparedTrimBoundaryId: idOf(12),
        };
        injectM0M1({
            db,
            sessionId: SESSION_ID,
            state: getOrCreateSessionMeta(db, SESSION_ID) as unknown as M0M1State,
            messages,
            preparedPrefix,
            isCacheBustingPass: true,
        });
    }

    it("control: two back-to-back busting preparations re-anchor on the second", () => {
        const db = seedDegraded();
        expect(reanchored(prepareCompartmentInjection(db, SESSION_ID, window(), true))).toBe(false);
        expect(reanchored(prepareCompartmentInjection(db, SESSION_ID, window(), true))).toBe(true);
    });

    it("the busting delivery's cache clear resets the count, so consecutive busting passes never re-anchor", () => {
        const db = seedDegraded();
        for (let pass = 0; pass < 3; pass += 1) {
            const live = window();
            const prepared = prepareCompartmentInjection(db, SESSION_ID, live, true);
            expect(reanchored(prepared)).toBe(false);
            bustingDelivery(db, live);
        }
    });

    it("defer passes advance the count while the boundary is absent, so the next busting pass re-anchors", () => {
        const db = seedDegraded();
        const busting = window();
        prepareCompartmentInjection(db, SESSION_ID, busting, true);
        bustingDelivery(db, busting);

        // Warm-cache defer passes: a rebuild that cannot find the boundary
        // caches its result with a null boundary, and a cached null boundary
        // makes the next defer pass rebuild instead of replaying, which counts
        // again. They
        // never re-anchor themselves (that would change bytes on a defer pass).
        expect(reanchored(prepareCompartmentInjection(db, SESSION_ID, window(), false))).toBe(
            false,
        );
        expect(reanchored(prepareCompartmentInjection(db, SESSION_ID, window(), false))).toBe(
            false,
        );

        // The next busting preparation runs before that pass's cache clear and
        // sees a count of 3.
        expect(reanchored(prepareCompartmentInjection(db, SESSION_ID, window(), true))).toBe(true);
    });
});
