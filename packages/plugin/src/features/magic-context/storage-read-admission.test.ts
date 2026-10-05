import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database, withSqliteBackgroundWriter } from "../../shared/sqlite";
import { createTestTempDirFromPath } from "../../shared/test-temp-dir";
import { closeDatabase, openDatabase } from "./storage-db";
import { getOrCreateSessionMeta } from "./storage-meta-session";
import { ensureSessionMetaRow } from "./storage-meta-shared";

const roots: string[] = [];
function fixture() {
    const root = createTestTempDirFromPath(join(tmpdir(), "mc-read-admission-"));
    roots.push(root);
    const path = join(root, "context.db");
    const db = openDatabase(path);
    if (!db) throw new Error("fixture failed to open");
    db.exec("PRAGMA busy_timeout=5");
    return { db, path };
}
afterEach(() => {
    closeDatabase();
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("read-only hot context opens", () => {
    it("cached opens do not attempt a writer when no lease is stale", () => {
        const { db, path } = fixture();
        ensureSessionMetaRow(db, "fresh");
        db.prepare(
            "UPDATE session_meta SET channel2_nudge_state = 'claimed', channel2_nudge_claimed_at = ? WHERE session_id = 'fresh'",
        ).run(Date.now());
        const exec = spyOn(db, "exec");
        const sibling = new Database(path);
        try {
            sibling.exec("BEGIN IMMEDIATE");
            expect(withSqliteBackgroundWriter(() => openDatabase(path))).toBe(db);
            expect(withSqliteBackgroundWriter(() => openDatabase(path))).toBe(db);
            // Every autocommit writer in this scope changes busy_timeout before
            // admission, even a cached statement whose BUSY error is swallowed.
            expect(
                exec.mock.calls.filter(([sql]) => sql.startsWith("PRAGMA busy_timeout=")),
            ).toHaveLength(0);
            expect(
                db
                    .prepare(
                        "SELECT channel2_nudge_state FROM session_meta WHERE session_id = 'fresh'",
                    )
                    .get(),
            ).toEqual({ channel2_nudge_state: "claimed" });
        } finally {
            exec.mockRestore();
            sibling.exec("ROLLBACK");
            sibling.close();
        }
    });

    it("existing metadata reads do not attempt INSERT OR IGNORE admission", () => {
        const { db, path } = fixture();
        ensureSessionMetaRow(db, "existing", true);
        const sibling = new Database(path);
        const prepare = spyOn(db, "prepare");
        try {
            sibling.exec("BEGIN IMMEDIATE");
            ensureSessionMetaRow(db, "existing", false);
            expect(getOrCreateSessionMeta(db, "existing").isSubagent).toBe(true);
            expect(
                prepare.mock.calls.filter(([sql]) =>
                    sql.startsWith("INSERT OR IGNORE INTO session_meta"),
                ),
            ).toHaveLength(0);
        } finally {
            prepare.mockRestore();
            sibling.exec("ROLLBACK");
            sibling.close();
        }
    });

    it("cached opens heal legacy and expired claims while preserving fresh claims", () => {
        const { db, path } = fixture();
        for (const id of ["legacy", "expired", "fresh"]) ensureSessionMetaRow(db, id);
        const update = db.prepare(
            "UPDATE session_meta SET channel2_nudge_state = 'claimed', channel2_nudge_claimed_at = ?, channel2_nudge_claim_token = ? WHERE session_id = ?",
        );
        update.run(0, "old", "legacy");
        update.run(Date.now() - 11 * 60_000, "old", "expired");
        update.run(Date.now(), "live", "fresh");
        openDatabase(path);
        expect(
            db
                .prepare(
                    "SELECT session_id, channel2_nudge_state, channel2_nudge_claim_token FROM session_meta ORDER BY session_id",
                )
                .all(),
        ).toEqual([
            { session_id: "expired", channel2_nudge_state: "", channel2_nudge_claim_token: "" },
            {
                session_id: "fresh",
                channel2_nudge_state: "claimed",
                channel2_nudge_claim_token: "live",
            },
            { session_id: "legacy", channel2_nudge_state: "", channel2_nudge_claim_token: "" },
        ]);
    });

    it("ensuring a missing row keeps defaults and does not replace an existing row", () => {
        const { db } = fixture();
        ensureSessionMetaRow(db, "new", true);
        db.prepare(
            "UPDATE session_meta SET counter = 71, last_nudge_tokens = 99 WHERE session_id = 'new'",
        ).run();
        ensureSessionMetaRow(db, "new", false);
        const meta = getOrCreateSessionMeta(db, "new");
        expect(meta.isSubagent).toBe(true);
        expect(meta.counter).toBe(71);
        expect(meta.lastNudgeTokens).toBe(99);
    });
});
