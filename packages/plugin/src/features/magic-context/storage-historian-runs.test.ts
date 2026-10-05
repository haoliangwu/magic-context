import { afterEach, beforeEach, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestTempDirFromPath } from "../../shared/test-temp-dir";
import { closeDatabase, openDatabase } from "./storage-db";
import {
    recordHistorianRun,
    summarizeImportance,
    tallyFactsByCategory,
} from "./storage-historian-runs";
import { clearSession } from "./storage-meta-session";

let tempHome: string;
let prevDataHome: string | undefined;

beforeEach(() => {
    prevDataHome = process.env.XDG_DATA_HOME;
    tempHome = createTestTempDirFromPath(join(tmpdir(), "mc-hr-"));
    process.env.XDG_DATA_HOME = tempHome;
    closeDatabase();
});

afterEach(() => {
    closeDatabase();
    if (prevDataHome === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = prevDataHome;
    rmSync(tempHome, { recursive: true, force: true });
});

test("summarizeImportance handles empty + mixed values", () => {
    expect(summarizeImportance([])).toEqual({ min: null, max: null, avg: null });
    expect(summarizeImportance([42])).toEqual({ min: 42, max: 42, avg: 42 });
    expect(summarizeImportance([10, 20, 60])).toEqual({ min: 10, max: 60, avg: 30 });
});

test("tallyFactsByCategory counts by category with UNKNOWN fallback", () => {
    expect(
        tallyFactsByCategory([
            { category: "ARCHITECTURE" },
            { category: "ARCHITECTURE" },
            { category: "CONFIG_VALUES" },
            { category: null },
            {},
        ]),
    ).toEqual({ ARCHITECTURE: 2, CONFIG_VALUES: 1, UNKNOWN: 2 });
});

test("records a success run with full metrics and reads back", () => {
    const db = openDatabase();
    const id = recordHistorianRun(db, {
        sessionId: "ses-1",
        harness: "opencode",
        subagentInvocationId: 99,
        runKind: "incremental",
        status: "success",
        chunkStartOrdinal: 1,
        chunkEndOrdinal: 165,
        unprocessedFrom: 166,
        compartmentsProduced: 3,
        compartmentIdMin: 10,
        compartmentIdMax: 12,
        factsEmitted: 4,
        factsByCategory: { ARCHITECTURE: 3, NAMING: 1 },
        factsPromoted: 3,
        eventsEmitted: 2,
        eventsPublished: 1,
        importanceMin: 25,
        importanceMax: 88,
        importanceAvg: 56.5,
        discardedLast: true,
        legacy: false,
    });
    expect(typeof id).toBe("number");

    const row = db.prepare("SELECT * FROM historian_runs WHERE id = ?").get(id) as Record<
        string,
        unknown
    >;
    expect(row.session_id).toBe("ses-1");
    expect(row.subagent_invocation_id).toBe(99);
    expect(row.run_kind).toBe("incremental");
    expect(row.status).toBe("success");
    expect(row.failure_reason).toBeNull();
    expect(row.chunk_start_ordinal).toBe(1);
    expect(row.chunk_end_ordinal).toBe(165);
    expect(row.unprocessed_from).toBe(166);
    expect(row.compartments_produced).toBe(3);
    expect(row.compartment_id_min).toBe(10);
    expect(row.compartment_id_max).toBe(12);
    expect(row.facts_emitted).toBe(4);
    expect(JSON.parse(row.facts_by_category_json as string)).toEqual({
        ARCHITECTURE: 3,
        NAMING: 1,
        facts_promoted: 3,
        events_published: 1,
    });
    expect(row.events_emitted).toBe(2);
    expect(row.importance_avg).toBe(56.5);
    expect(row.discarded_last).toBe(1);
    expect(row.legacy).toBe(0);
});

test("records a failure run with a reason and no compartments", () => {
    const db = openDatabase();
    const id = recordHistorianRun(db, {
        sessionId: "ses-2",
        harness: "pi",
        runKind: "recomp",
        status: "failed",
        failureReason: "validation: bad output",
    });
    const row = db
        .prepare(
            "SELECT status, failure_reason, compartments_produced, subagent_invocation_id FROM historian_runs WHERE id = ?",
        )
        .get(id) as Record<string, unknown>;
    expect(row.status).toBe("failed");
    expect(row.failure_reason).toBe("validation: bad output");
    expect(row.compartments_produced).toBe(0);
    expect(row.subagent_invocation_id).toBeNull();
});

test("clearSession deletes a session's historian_runs", () => {
    const db = openDatabase();
    recordHistorianRun(db, {
        sessionId: "ses-clear",
        harness: "opencode",
        runKind: "incremental",
        status: "success",
    });
    expect(
        (
            db
                .prepare("SELECT COUNT(*) AS c FROM historian_runs WHERE session_id = ?")
                .get("ses-clear") as { c: number }
        ).c,
    ).toBe(1);

    clearSession(db, "ses-clear");

    expect(
        (
            db
                .prepare("SELECT COUNT(*) AS c FROM historian_runs WHERE session_id = ?")
                .get("ses-clear") as { c: number }
        ).c,
    ).toBe(0);
});
