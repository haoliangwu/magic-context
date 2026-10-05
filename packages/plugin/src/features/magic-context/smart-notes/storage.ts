import { log } from "../../../shared/logger";
import type { Database } from "../../../shared/sqlite";
import { logSlowWriteTransaction } from "../../../shared/write-transaction-timing";
import { setPersistedNoteNudgeTrigger } from "../storage-meta-persisted";
import { addNote, getPendingSmartNotes, type Note, type NoteCheckStatus } from "../storage-notes";
import {
    SMART_NOTE_CHECK_LIVENESS_RECHECK_MS,
    SMART_NOTE_CHECK_MAX_STALENESS_MS,
    SMART_NOTE_CHECK_POLICY_VERSION,
    type SmartNoteCheckManifest,
    type SmartNoteCheckNote,
} from "./types";

function toSmartNote(note: Note): SmartNoteCheckNote {
    return {
        ...note,
        checkStatus: note.checkStatus ?? "uncompiled",
        checkFailureCount: note.checkFailureCount ?? 0,
        checkNetworkFailureCount: note.checkNetworkFailureCount ?? 0,
        policyVersion: note.policyVersion ?? 0,
    };
}

export type SmartNoteCommitExpectation =
    | {
          kind: "source-revision";
          noteId: number;
          content: string;
          surfaceCondition: string | null;
          updatedAt: number;
          checkStatus?: NoteCheckStatus;
      }
    | {
          kind: "compiled-check";
          noteId: number;
          compiledCheck: string;
          checkHash: string | null;
          checkCompiledAt: number | null;
      };

export function commitSmartNoteState(
    db: Database,
    args: {
        phase: string;
        expected: SmartNoteCommitExpectation;
        leaseHeld?: () => boolean;
        write: () => void;
    },
): boolean {
    // BEGIN IMMEDIATE, not a plain (deferred) transaction: the lease check reads
    // before the write, and a deferred read→write lock upgrade returns
    // SQLITE_BUSY immediately when another writer holds the lock — busy_timeout
    // does not apply to upgrades, so concurrent processes produced spurious
    // "database is locked" failures here. Taking the write lock at BEGIN time
    // waits under busy_timeout like every other writer.
    db.exec("BEGIN IMMEDIATE");
    const transactionStartedAt = performance.now();
    let leaseLost = false;
    let committed = false;
    try {
        // State transitions surface notes or change future scheduling. The lease
        // check and compare-and-set guard share the write transaction so neither
        // ownership nor the user's source state can change before the update.
        if (args.leaseHeld && !args.leaseHeld()) {
            leaseLost = true;
        } else if (claimExpectedState(db, args.expected)) {
            args.write();
            committed = true;
        }
        db.exec("COMMIT");
        logSlowWriteTransaction("smart_note_commit", transactionStartedAt);
    } catch (error) {
        try {
            db.exec("ROLLBACK");
        } catch {
            // Connection-level failures leave nothing to roll back.
        }
        throw error;
    }
    if (leaseLost) {
        throw new Error(`Dream lease lost during smart-note ${args.phase} commit`);
    }
    if (!committed) {
        log(`[debug] smart note #${args.expected.noteId}: discarded stale ${args.phase} result`);
    }
    return committed;
}

function claimExpectedState(db: Database, expected: SmartNoteCommitExpectation): boolean {
    if (expected.kind === "compiled-check") {
        return (
            db
                .prepare(
                    `UPDATE notes SET id = id
                     WHERE id = ? AND type = 'smart' AND status = 'pending'
                       AND check_status = 'compiled' AND compiled_check = ?
                       AND check_hash IS ? AND check_compiled_at IS ?`,
                )
                .run(
                    expected.noteId,
                    expected.compiledCheck,
                    expected.checkHash,
                    expected.checkCompiledAt,
                ).changes > 0
        );
    }
    const statusClause = expected.checkStatus ? " AND check_status = ?" : "";
    const params: Array<string | number | null> = [
        expected.noteId,
        expected.content,
        expected.surfaceCondition,
        expected.updatedAt,
    ];
    if (expected.checkStatus) params.push(expected.checkStatus);
    return (
        db
            .prepare(
                `UPDATE notes SET id = id
                 WHERE id = ? AND type = 'smart' AND status = 'pending'
                   AND content = ? AND surface_condition IS ? AND updated_at = ?${statusClause}`,
            )
            .run(...params).changes > 0
    );
}

export function getDueCompiledSmartNoteChecks(
    db: Database,
    projectPath: string,
    now: number,
    limit: number,
    retinaHandoff = false,
): SmartNoteCheckNote[] {
    return getPendingSmartNotes(db, projectPath)
        .filter((note) => !retinaHandoff || note.compileStatus !== "compiled")
        .map(toSmartNote)
        .filter(
            (note) =>
                note.checkStatus === "compiled" &&
                note.compiledCheck !== null &&
                note.policyVersion === SMART_NOTE_CHECK_POLICY_VERSION &&
                (note.checkQuarantinedUntil === null || note.checkQuarantinedUntil <= now) &&
                (note.checkNextDueAt === null || note.checkNextDueAt <= now),
        )
        .sort((a, b) => (a.checkNextDueAt ?? 0) - (b.checkNextDueAt ?? 0) || a.id - b.id)
        .slice(0, Math.max(1, limit));
}

export function getSmartNotesNeedingCompilation(
    db: Database,
    projectPath: string,
    now: number,
    limit: number,
    retinaHandoff = false,
): SmartNoteCheckNote[] {
    return getPendingSmartNotes(db, projectPath)
        .filter((note) => !retinaHandoff || note.compileStatus !== "compiled")
        .map(toSmartNote)
        .filter(
            (note) =>
                note.checkStatus !== "parked" &&
                (note.checkNextDueAt === null || note.checkNextDueAt <= now) &&
                (note.checkStatus === "uncompiled" ||
                    note.checkStatus === "failing" ||
                    note.compiledCheck === null ||
                    note.policyVersion !== SMART_NOTE_CHECK_POLICY_VERSION),
        )
        .sort((a, b) => a.createdAt - b.createdAt || a.id - b.id)
        .slice(0, Math.max(1, limit));
}

export function getStaleCompiledSmartNotes(
    db: Database,
    projectPath: string,
    now: number,
    limit: number,
    retinaHandoff = false,
): SmartNoteCheckNote[] {
    const staleBefore = now - SMART_NOTE_CHECK_MAX_STALENESS_MS;
    const livenessBefore = now - SMART_NOTE_CHECK_LIVENESS_RECHECK_MS;
    return getPendingSmartNotes(db, projectPath)
        .filter((note) => !retinaHandoff || note.compileStatus !== "compiled")
        .map(toSmartNote)
        .filter(
            (note) =>
                note.checkStatus === "compiled" &&
                note.compiledCheck !== null &&
                (note.checkQuarantinedUntil === null || note.checkQuarantinedUntil <= now) &&
                note.policyVersion === SMART_NOTE_CHECK_POLICY_VERSION &&
                note.checkFalseSinceAt !== null &&
                note.checkFalseSinceAt <= staleBefore &&
                (note.checkLastLivenessAt === null || note.checkLastLivenessAt <= livenessBefore),
        )
        .sort((a, b) => (a.checkFalseSinceAt ?? 0) - (b.checkFalseSinceAt ?? 0) || a.id - b.id)
        .slice(0, Math.max(1, limit));
}

export function storeCompiledSmartNoteCheck(
    db: Database,
    args: {
        noteId: number;
        compiledCheck: string;
        manifest: SmartNoteCheckManifest;
        checkHash: string;
        checkCron: string;
        nextDueAt: number;
        now: number;
    },
): void {
    db.prepare(
        `UPDATE notes
         SET compiled_check = ?,
             manifest_json = ?,
             check_hash = ?,
             check_cron = ?,
             check_version = 1,
             check_status = 'compiled',
             check_failure_count = 0,
             check_network_failure_count = 0,
             check_quarantined_until = NULL,
             ready_reason = NULL,
             check_next_due_at = ?,
             check_compiled_at = ?,
             check_false_since_at = COALESCE(check_false_since_at, ?),
             check_last_liveness_at = NULL,
             policy_version = ?,
             updated_at = ?
         WHERE id = ? AND type = 'smart'`,
    ).run(
        args.compiledCheck,
        JSON.stringify(args.manifest),
        args.checkHash,
        args.checkCron,
        args.nextDueAt,
        args.now,
        args.now,
        SMART_NOTE_CHECK_POLICY_VERSION,
        args.now,
        args.noteId,
    );
}

export function markCompiledCheckFalse(
    db: Database,
    noteId: number,
    nextDueAt: number,
    now: number,
): void {
    db.prepare(
        `UPDATE notes
         SET last_checked_at = ?,
             updated_at = ?,
             check_next_due_at = ?,
             check_failure_count = 0,
             check_network_failure_count = 0,
             check_false_since_at = COALESCE(check_false_since_at, ?)
         WHERE id = ? AND type = 'smart'`,
    ).run(now, now, nextDueAt, now, noteId);
}

export function markCompiledCheckLogicFailure(
    db: Database,
    noteId: number,
    now: number,
    maxFailures: number,
): void {
    const failureCount = readFailureCount(db, noteId, "check_failure_count") + 1;
    const status: NoteCheckStatus = failureCount >= maxFailures ? "failing" : "compiled";
    db.prepare(
        `UPDATE notes
         SET check_failure_count = ?,
             check_status = ?,
             check_next_due_at = ?,
             updated_at = ?
         WHERE id = ? AND type = 'smart'`,
    ).run(failureCount, status, now + backoffMs(failureCount), now, noteId);
}

export function markCompiledCheckNetworkFailure(
    db: Database,
    noteId: number,
    now: number,
    maxFailures: number,
    retryAt?: number,
): void {
    const failureCount = readFailureCount(db, noteId, "check_network_failure_count") + 1;
    const quarantinedUntil = Math.max(now + backoffMs(failureCount), retryAt ?? 0);
    const status: NoteCheckStatus =
        retryAt === undefined && failureCount >= maxFailures ? "failing" : "compiled";
    db.prepare(
        `UPDATE notes
         SET check_network_failure_count = ?,
             check_status = ?,
             check_next_due_at = ?,
             check_quarantined_until = ?,
             updated_at = ?
         WHERE id = ? AND type = 'smart'`,
    ).run(failureCount, status, quarantinedUntil, quarantinedUntil, now, noteId);
}

export function markSmartNoteLivenessChecked(db: Database, noteId: number, now: number): void {
    db.prepare(
        `UPDATE notes
         SET check_last_liveness_at = ?, updated_at = ?
         WHERE id = ? AND type = 'smart'`,
    ).run(now, now, noteId);
}

export function markSmartNoteCheckStatus(
    db: Database,
    noteId: number,
    status: NoteCheckStatus,
    now: number,
): void {
    db.prepare(
        `UPDATE notes SET check_status = ?, updated_at = ? WHERE id = ? AND type = 'smart'`,
    ).run(status, now, noteId);
}

export function markSmartNoteCompilationFailure(
    db: Database,
    noteId: number,
    now: number,
    maxFailures: number,
    error: string,
    persistent: boolean,
    fallbackSessionId?: string,
    retryAt?: number,
    uncheckable = false,
): void {
    db.transaction(() => {
        const failureCount = readFailureCount(db, noteId, "check_failure_count") + 1;
        // Body-size failures can be reauthored later. Inaccessible sources cannot
        // improve by retrying the same unauthenticated check; only a condition edit
        // should enable compilation, scheduled checks or fallback evaluation again.
        const parked = persistent && uncheckable && retryAt === undefined;
        const status: NoteCheckStatus = parked
            ? "parked"
            : persistent
              ? "uncompiled"
              : retryAt === undefined && failureCount >= maxFailures
                ? "fallback"
                : "uncompiled";
        const nextDueAt = parked
            ? null
            : Math.max(
                  now + (persistent ? 7 * 24 * 60 * 60 * 1_000 : backoffMs(failureCount)),
                  retryAt ?? 0,
              );
        db.prepare(
            `UPDATE notes
         SET check_failure_count = ?,
             check_status = ?,
             check_next_due_at = ?,
             ready_reason = ?,
             updated_at = ?
         WHERE id = ? AND type = 'smart'`,
        ).run(
            failureCount,
            status,
            nextDueAt,
            // Only a failure that will repeat regardless of the watched event asks the
            // owner to rewrite the condition; a transient failure just retries.
            persistent ? `Condition can't be checked: ${error}; rewrite it` : null,
            now,
            noteId,
        );
        if (persistent || (retryAt === undefined && failureCount >= maxFailures)) {
            const source = db
                .prepare(
                    "SELECT session_id, surface_condition FROM notes WHERE id = ? AND type = 'smart'",
                )
                .get(noteId) as
                | { session_id: string | null; surface_condition: string | null }
                | undefined;
            const ownerSessionId = source?.session_id ?? fallbackSessionId;
            if (source && ownerSessionId) {
                const prefix = `Smart note #${noteId} cannot be checked.\nCondition: ${source.surface_condition}\nReason: `;
                // Keep the notice even after dismissal so retries of the same condition
                // cannot create another owner alert. The source note remains pending.
                const alreadyNotified = db
                    .prepare(`SELECT 1 FROM notes
                    WHERE type = 'session' AND session_id = ?
                      AND substr(content, 1, length(?)) = ? LIMIT 1`)
                    .get(ownerSessionId, prefix, prefix);
                if (!alreadyNotified) {
                    addNote(db, "session", {
                        sessionId: ownerSessionId,
                        content: `${prefix}${error.slice(0, 2048)}\nRewrite the condition or repair its data source; this is not evidence that it is met.${parked ? " Checks are paused; update surface_condition to a different condition to retry." : ""}`,
                    });
                    setPersistedNoteNudgeTrigger(db, ownerSessionId);
                }
            }
        }
    }).immediate();
}

function readFailureCount(db: Database, noteId: number, column: string): number {
    if (column !== "check_failure_count" && column !== "check_network_failure_count") return 0;
    const row = db.prepare(`SELECT ${column} AS count FROM notes WHERE id = ?`).get(noteId) as
        | { count?: number | null }
        | undefined;
    return row?.count ?? 0;
}

function backoffMs(failureCount: number): number {
    const minutes = Math.min(24 * 60, 5 * 2 ** Math.max(0, failureCount - 1));
    return minutes * 60 * 1000;
}
