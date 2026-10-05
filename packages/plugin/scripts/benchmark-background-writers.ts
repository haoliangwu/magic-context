// Offline maintenance probe. Only accepts a database copied beneath the system temp directory.
import assert from "node:assert/strict";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const path = realpathSync(process.argv[2]);
assert(path.startsWith(`${realpathSync(tmpdir())}/magic-context/`), "a throwaway database copy is required");
const root = dirname(path);
process.env.MAGIC_CONTEXT_STORAGE_DIR = root;
process.env.MAGIC_CONTEXT_LOG_PATH = join(root, "maintenance.log");
process.env.XDG_DATA_HOME = root;
process.env.XDG_CACHE_HOME = root;
const { Database } = await import("../src/shared/sqlite");
const db = new Database(path);
db.exec("PRAGMA busy_timeout=0");
const exec = db.exec.bind(db);
let acquiredAt: number | undefined;
let holds: number[] = [];
db.exec = (sql: string) => {
    const result = exec(sql);
    if (/^BEGIN IMMEDIATE$/i.test(sql)) acquiredAt = performance.now();
    if (/^(COMMIT|ROLLBACK)$/i.test(sql) && acquiredAt !== undefined) {
        holds.push(performance.now() - acquiredAt);
        acquiredAt = undefined;
    }
    return result;
};
async function probe(site: string, run: () => unknown) {
    holds = [];
    const start = performance.now();
    const result = await run();
    console.log(JSON.stringify({ site, wallMs: performance.now() - start, holdsMs: holds, result }));
}
try {
    const { runSessionProjectBackfill } = await import("../src/features/magic-context/session-project-backfill");
    await probe("session_project_backfill", () => runSessionProjectBackfill(db, [], { leaseKey: `probe-${Date.now()}` }));
    const { backfillMessageFtsRowidMapBatch } = await import("../src/features/magic-context/message-fts-rowid-map");
    db.prepare("UPDATE message_fts_rowid_map_backfill_state SET watermark_rowid=0, completed=0").run();
    await probe("message_fts_rowid_backfill", () => backfillMessageFtsRowidMapBatch(db));
    const { backfillMessageTimesBatch } = await import("../src/features/magic-context/message-time-backfill");
    db.prepare("UPDATE message_time_backfill_state SET cursor_session_id='', cursor_ordinal=0, completed=0").run();
    await probe("message_time_backfill", () => backfillMessageTimesBatch(db, () => []));
    const { acquireGitSweepLease, releaseGitSweepLease } = await import("../src/features/magic-context/git-commits/sweep-coordinator");
    await probe("git_sweep_lease", () => acquireGitSweepLease(db, "git:maintenance-probe", "probe"));
    releaseGitSweepLease(db, "git:maintenance-probe", "probe");
    const { acquireLease, runLeaseGuardedWrite, releaseLease } = await import("../src/features/magic-context/dreamer/lease");
    acquireLease(db, "probe", "maintenance-probe");
    await probe("lease-guarded-write", () => runLeaseGuardedWrite(db, "probe", "maintenance-probe", () => db.prepare("UPDATE session_project_backfill_state SET holder_id=holder_id WHERE harness='pi'").run()));
    releaseLease(db, "probe", "maintenance-probe");
    const { registerProjectEmbedding, sweepStaleEmbeddingIdentitiesForProject } = await import("../src/features/magic-context/project-embedding-registry");
    const projects = db.prepare("SELECT project_path FROM git_commits GROUP BY project_path ORDER BY COUNT(*) DESC LIMIT 3").all() as Array<{ project_path: string }>;
    for (const { project_path: project } of projects) {
        db.prepare("DELETE FROM embedding_identity_active WHERE project_path=?").run(project);
        await probe(`embedding_identity_record:${project}`, () => {
            const snapshot = registerProjectEmbedding(db, project, { provider: "local", model: "offline-maintenance-probe", local_runtime: "auto" }, { memoryEnabled: true, gitCommitEnabled: true }, root);
            return snapshot.modelId;
        });
        await probe(`embedding_identity_record_steady:${project}`, () => {
            const snapshot = registerProjectEmbedding(db, project, { provider: "local", model: "offline-maintenance-probe", local_runtime: "auto" }, { memoryEnabled: true, gitCommitEnabled: true }, root);
            return snapshot.modelId;
        });
        db.prepare("UPDATE embedding_identity_active SET last_active_at=0 WHERE project_path=? AND model_id NOT LIKE '%offline-maintenance-probe%'").run(project);
        await probe(`embedding_stale_gc:${project}`, () => sweepStaleEmbeddingIdentitiesForProject(db, project, Date.now() + 30 * 86400000));
    }
    const { pruneStaleLkgSlots } = await import("../src/hooks/magic-context/lkg-persist");
    // Use a future retention cutoff only on this copy so real saved-request
    // prefixes become eligible even when the original sessions were recently used.
    for (let batch = 0; batch < 3; batch++) {
        await probe("lkg_prune", () => pruneStaleLkgSlots(db, Date.now() + 30 * 86400000));
    }
} finally {
    db.close();
}
