/// <reference types="bun-types" />
import { createTestTempDirFromPath } from "../../shared/test-temp-dir";

// A native OpenCode compaction (`/compact`) replaces the host window with
// [compaction request, summary, retained tail, newer rows]. The next pass must
// re-anchor the cached baseline (fold m[1] into m[0] and move the stored boundary
// to the latest compartment end) instead of waiting for a later cache-busting
// pass. The fold rides the cache loss the compaction already caused, so it must
// fire once per compaction and never again for the same one.

import { afterEach, describe, expect, it } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    appendCompartments,
    type CompartmentInput,
} from "../../features/magic-context/compartment-storage";
import { getOrCreateSessionMeta } from "../../features/magic-context/storage";
import { initializeDatabase } from "../../features/magic-context/storage-db";
import { Database } from "../../shared/sqlite";
import { CACHE_LOSING_FOLD_REASONS } from "./apply-operations";
import { MARKER_SUMMARY_TEXT } from "./compaction-marker-manager";
import {
    findHostCompactionWindow,
    type HostCompactionWindow,
    injectM0M1,
    type M0HardSignals,
} from "./inject-compartments";
import type { MessageLike } from "./tag-messages";

const SESSION_ID = "ses_host_compaction";
const PROJECT_PATH = "/tmp/test-host-compaction-project";

const BASE_HARD: M0HardSignals = {
    systemHash: "sys-v1",
    modelKey: "anthropic/opus",
    cacheExpired: false,
    lastResponseTime: 0,
};

let db: Database | undefined;
const tempDirs: string[] = [];

afterEach(() => {
    db?.close();
    db = undefined;
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function compartment(seq: number, title: string, body: string): CompartmentInput {
    return {
        sequence: seq,
        startMessage: seq,
        endMessage: seq,
        startMessageId: `m${seq}`,
        endMessageId: `m${seq}`,
        title,
        content: body,
        p1: body,
    };
}

function pass(projectDirectory: string, isCacheBustingPass: boolean, hard: M0HardSignals) {
    if (!db) throw new Error("database not initialised");
    const result = injectM0M1({
        db,
        sessionId: SESSION_ID,
        state: getOrCreateSessionMeta(db, SESSION_ID),
        projectPath: PROJECT_PATH,
        projectDirectory,
        historyBudgetTokens: 98_000,
        isCacheBustingPass,
        hardSignals: hard,
    });
    return {
        m0: result.m0Bytes?.toString("utf8") ?? "",
        m1: result.m1Text ?? "",
        rematerialized: result.m0RematerializedThisPass,
        reason: result.decision.reason,
    };
}

function storedBoundary(): string | null {
    const row = db
        ?.prepare(
            "SELECT cached_m0_last_baseline_end_message_id AS id FROM session_meta WHERE session_id = ?",
        )
        .get(SESSION_ID) as { id: string | null } | undefined;
    return row?.id ?? null;
}

function materializedAt(): number {
    const row = db
        ?.prepare("SELECT cached_m0_materialized_at AS at FROM session_meta WHERE session_id = ?")
        .get(SESSION_ID) as { at: number | null } | undefined;
    return row?.at ?? 0;
}

/** A baseline over compartment 0, then compartment 1 published but not yet folded. */
function sessionWithUnfoldedCompartment(): string {
    db = new Database(":memory:");
    initializeDatabase(db);
    getOrCreateSessionMeta(db, SESSION_ID);
    const projectDirectory = createTestTempDirFromPath(join(tmpdir(), "mc-host-compaction-"));
    tempDirs.push(projectDirectory);
    appendCompartments(db, SESSION_ID, [compartment(0, "Alpha", "Alpha baseline")]);
    pass(projectDirectory, true, BASE_HARD);
    appendCompartments(db, SESSION_ID, [compartment(1, "Beta", "Beta published later")]);
    return projectDirectory;
}

/**
 * A compaction that finished after the cached baseline was built and before now.
 * The baseline is moved an hour into the past so both timestamps are real past
 * times, as they are when the next pass runs after a `/compact`.
 */
function hostCompactionAfterLastFold(): HostCompactionWindow {
    const baselineAt = Date.now() - 60 * 60 * 1000;
    db?.prepare("UPDATE session_meta SET cached_m0_materialized_at = ? WHERE session_id = ?").run(
        baselineAt,
        SESSION_ID,
    );
    return {
        compactionMessageId: "msg_compaction_request",
        summaryMessageId: "msg_compaction_summary",
        completedAt: baselineAt + 1_000,
    };
}

describe("fold after a native host compaction", () => {
    it("re-anchors the baseline on the next pass, even one that would otherwise defer", () => {
        const projectDirectory = sessionWithUnfoldedCompartment();
        const before = pass(projectDirectory, false, BASE_HARD);
        expect(before.rematerialized).toBe(false);
        expect(before.m0).not.toContain("Beta published later");
        expect(storedBoundary()).toBe("m0");

        const hard = { ...BASE_HARD, hostCompaction: hostCompactionAfterLastFold() };
        const fold = pass(projectDirectory, false, hard);
        expect(fold.reason).toBe("host_compaction");
        expect(fold.rematerialized).toBe(true);
        // Which history is rendered does not change: both compartments stay in m[0].
        expect(fold.m0).toContain("Alpha baseline");
        expect(fold.m0).toContain("Beta published later");
        expect(storedBoundary()).toBe("m1");
    });

    it("folds once per compaction: the same compaction never folds again", () => {
        const projectDirectory = sessionWithUnfoldedCompartment();
        const hard = { ...BASE_HARD, hostCompaction: hostCompactionAfterLastFold() };
        const fold = pass(projectDirectory, false, hard);
        expect(fold.rematerialized).toBe(true);

        const replay = pass(projectDirectory, false, hard);
        expect(replay.rematerialized).toBe(false);
        expect(replay.reason).not.toBe("host_compaction");
        expect(replay.m0).toBe(fold.m0);
        expect(replay.m1).toBe(fold.m1);
    });

    it("does not fold for a compaction older than the cached baseline", () => {
        const projectDirectory = sessionWithUnfoldedCompartment();
        const before = pass(projectDirectory, false, BASE_HARD);
        const hard = {
            ...BASE_HARD,
            hostCompaction: {
                compactionMessageId: "msg_compaction_request",
                summaryMessageId: "msg_compaction_summary",
                completedAt: materializedAt() - 1,
            },
        };
        const after = pass(projectDirectory, false, hard);
        expect(after.rematerialized).toBe(false);
        expect(after.m0).toBe(before.m0);
        expect(after.m1).toBe(before.m1);
        expect(storedBoundary()).toBe("m0");
    });

    it("counts as a fold whose cache loss the host already caused", () => {
        expect(CACHE_LOSING_FOLD_REASONS.has("host_compaction")).toBe(true);
    });
});

function user(id: string, parts: unknown[]): MessageLike {
    return { info: { id, role: "user" }, parts };
}

function summary(id: string, parentID: string, text: string, extra: Record<string, unknown> = {}) {
    return {
        info: {
            id,
            role: "assistant",
            summary: true,
            finish: "stop",
            parentID,
            time: { created: 1_000, completed: 2_000 },
            ...extra,
        },
        parts: [{ type: "text", text }],
    } as MessageLike;
}

describe("findHostCompactionWindow", () => {
    const compactionRequest = user("msg_c", [{ type: "compaction", auto: false }]);
    const tail = user("msg_t", [{ type: "text", text: "retained turn" }]);
    const noMarker = () => null;

    it("reads a native compaction pair at the head of the window", () => {
        expect(
            findHostCompactionWindow(
                [compactionRequest, summary("msg_s", "msg_c", "what we did"), tail],
                noMarker,
            ),
        ).toEqual({
            compactionMessageId: "msg_c",
            summaryMessageId: "msg_s",
            completedAt: 2_000,
        });
    });

    it("ignores Magic Context's own marker pair, by placeholder text or by stored id", () => {
        expect(
            findHostCompactionWindow(
                [compactionRequest, summary("msg_s", "msg_c", MARKER_SUMMARY_TEXT), tail],
                noMarker,
            ),
        ).toBeNull();
        expect(
            findHostCompactionWindow(
                [compactionRequest, summary("msg_s", "msg_c", "tag-dropped placeholder"), tail],
                () => "msg_s",
            ),
        ).toBeNull();
    });

    it("ignores an unfinished or failed summary and a pair that is not at the head", () => {
        expect(
            findHostCompactionWindow(
                [compactionRequest, summary("msg_s", "msg_c", "x", { finish: undefined }), tail],
                noMarker,
            ),
        ).toBeNull();
        expect(
            findHostCompactionWindow(
                [compactionRequest, summary("msg_s", "msg_c", "x", { error: { name: "E" } }), tail],
                noMarker,
            ),
        ).toBeNull();
        expect(
            findHostCompactionWindow(
                [tail, compactionRequest, summary("msg_s", "msg_c", "x")],
                noMarker,
            ),
        ).toBeNull();
    });

    it("reads no stored marker state on an ordinary window", () => {
        let reads = 0;
        const result = findHostCompactionWindow(
            [tail, user("msg_u", [{ type: "text", text: "next" }])],
            () => {
                reads += 1;
                return null;
            },
        );
        expect(result).toBeNull();
        expect(reads).toBe(0);
    });
});
