import { expect, test } from "bun:test";
import { Database } from "../../shared/sqlite";
import { countHistorianRuns } from "./storage-historian-runs";
import { getLatestHistorianInvocationId } from "./storage-subagent-invocations";

// The Rust dashboard-shape test exports context.db so this test can exercise the session
// status command's run-count reader on records written by Rust, not TypeScript fixtures.
const path = process.env.MC_HISTORIAN_TEST_DB;
(path ? test : test.skip)(
    "ctx-status reads the Rust historian's published run and invocation",
    () => {
        if (!path) throw new Error("MC_HISTORIAN_TEST_DB is required");
        const db = new Database(path, { readonly: true });
        try {
            expect(countHistorianRuns(db, "ses")).toBe(1);
            expect(countHistorianRuns(db, "another-session")).toBe(0);
            const id = getLatestHistorianInvocationId(db, "ses");
            expect(id).not.toBeNull();
            const run = db
                .prepare(
                    "SELECT subagent_invocation_id, status, compartments_produced FROM historian_runs WHERE session_id = ?",
                )
                .get("ses") as {
                subagent_invocation_id: number;
                status: string;
                compartments_produced: number;
            };
            expect(run).toEqual({
                subagent_invocation_id: id,
                status: "success",
                compartments_produced: 1,
            });
        } finally {
            db.close();
        }
    },
);
