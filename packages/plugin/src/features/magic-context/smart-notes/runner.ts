import type { Database } from "../../../shared/sqlite";
import { getLeaseHolder, peekLeaseHolderAndExpiry } from "../dreamer/lease";
import { leaseKeyFor } from "../dreamer/task-registry";
import { markNoteReady } from "../storage-notes";
import { createSmartNoteCapabilities, readSmartNoteGithubToken } from "./capabilities";
import { runCompiledSmartNoteCheck, SMART_NOTE_CHECK_TIMEOUT_MS } from "./sandbox-runner";
import { nextSmartNoteCheckDueAt } from "./schedule";
import {
    commitSmartNoteState,
    getDueCompiledSmartNoteChecks,
    markCompiledCheckFalse,
    markCompiledCheckLogicFailure,
    markCompiledCheckNetworkFailure,
    markSmartNoteCompilationFailure,
} from "./storage";
import { parseSmartNoteManifest } from "./types";
import { wakePlaneStatus } from "./wake-plane";

export interface RunDueCompiledSmartNoteChecksArgs {
    db: Database;
    projectIdentity: string;
    projectRoot: string;
    now?: number;
    maxChecks?: number;
    sweepBudgetMs?: number;
    leaseHeld?: () => boolean;
    signal?: AbortSignal;
    retinaHandoff?: boolean;
    githubToken?: string | null;
}

export interface RunDueCompiledSmartNoteChecksResult {
    ran: number;
    surfaced: number;
    failed: number;
    networkFailed: number;
}

function inferEvaluateSmartNotesLeaseHeld(
    db: Database,
    projectIdentity: string,
): (() => boolean) | undefined {
    const leaseKey = leaseKeyFor("evaluate-smart-notes", projectIdentity);
    const holderId = getLeaseHolder(db, leaseKey);
    if (!holderId || !peekLeaseHolderAndExpiry(db, holderId, leaseKey)) return undefined;
    return () => peekLeaseHolderAndExpiry(db, holderId, leaseKey);
}

const DEFAULT_MAX_CHECKS = 10;
const DEFAULT_SWEEP_BUDGET_MS = 15_000;
const MAX_FAILURES_BEFORE_REAUTHOR = 3;

export async function runDueCompiledSmartNoteChecks(
    args: RunDueCompiledSmartNoteChecksArgs,
): Promise<RunDueCompiledSmartNoteChecksResult> {
    if ((await wakePlaneStatus()) === "present") {
        return { ran: 0, surfaced: 0, failed: 0, networkFailed: 0 };
    }

    const startedAt = Date.now();
    const now = args.now ?? startedAt;
    const due = getDueCompiledSmartNoteChecks(
        args.db,
        args.projectIdentity,
        now,
        args.maxChecks ?? DEFAULT_MAX_CHECKS,
        args.retinaHandoff,
    );
    let ran = 0;
    let surfaced = 0;
    let failed = 0;
    let networkFailed = 0;
    const leaseHeld =
        args.leaseHeld ?? inferEvaluateSmartNotesLeaseHeld(args.db, args.projectIdentity);
    const githubToken =
        args.githubToken === undefined ? await readSmartNoteGithubToken() : args.githubToken;

    for (const note of due) {
        const remaining =
            (args.sweepBudgetMs ?? DEFAULT_SWEEP_BUDGET_MS) - (Date.now() - startedAt);
        if (remaining <= 0) break;
        // Admit fewer notes rather than shorten their network deadline. The first
        // attempt still supports explicitly small test/caller budgets. Loading
        // and VM queuing must finish within the sweep's remaining budget.
        if (ran > 0 && remaining < SMART_NOTE_CHECK_TIMEOUT_MS) break;
        if (!note.compiledCheck) continue;
        const compiledCheck = note.compiledCheck;
        ran++;
        const controller = new AbortController();
        const abortFromCaller = () => controller.abort(args.signal?.reason);
        if (args.signal?.aborted) abortFromCaller();
        else args.signal?.addEventListener("abort", abortFromCaller, { once: true });
        const timer = setTimeout(
            () => controller.abort(new Error("smart-note sweep budget exhausted")),
            remaining,
        );
        try {
            const result = await runCompiledSmartNoteCheck({
                compiledCheck,
                capabilityFactory: (signal) =>
                    createSmartNoteCapabilities({
                        projectRoot: args.projectRoot,
                        signal,
                        githubToken,
                    }),
                signal: controller.signal,
                // Treat the sweep deadline as an admission/queue deadline, not
                // an execution deadline: a check that starts in time gets its
                // full CPU and HTTP budgets even after a slow VM load. The VM's
                // own deadline caps overrun at one check (6s), and no later note
                // is admitted once the sweep budget is spent. Caller/lease
                // cancellation still interrupts an active check immediately.
                onExecutionStart: () => {
                    clearTimeout(timer);
                    // Loading can block the host event loop past an eligible
                    // timer. Do not admit execution merely because its callback
                    // has not been delivered yet.
                    if (Date.now() - startedAt >= (args.sweepBudgetMs ?? DEFAULT_SWEEP_BUDGET_MS)) {
                        controller.abort(new Error("smart-note sweep budget exhausted"));
                    }
                },
            });
            const runFinishedAt = Date.now();
            const expected = {
                kind: "compiled-check" as const,
                noteId: note.id,
                compiledCheck,
                checkHash: note.checkHash,
                checkCompiledAt: note.checkCompiledAt,
            };
            if (!result.ok && result.cancelled) {
                continue;
            }
            if (result.ok && result.result.met) {
                const committed = commitSmartNoteState(args.db, {
                    phase: "due check",
                    expected,
                    leaseHeld,
                    write: () => {
                        markNoteReady(
                            args.db,
                            note.id,
                            hostGeneratedReadyReason(note.id, note.manifestJson),
                        );
                    },
                });
                if (committed) surfaced++;
            } else if (result.ok) {
                // Cron search is bounded and completed before the write lock so
                // schedule evaluation cannot extend the state transaction.
                const nextDueAt = nextSmartNoteCheckDueAt(note.checkCron, {
                    now: runFinishedAt,
                    noteId: note.id,
                    hash: note.checkHash,
                });
                commitSmartNoteState(args.db, {
                    phase: "due check",
                    expected,
                    leaseHeld,
                    write: () => {
                        markCompiledCheckFalse(args.db, note.id, nextDueAt, runFinishedAt);
                    },
                });
            } else if (result.network) {
                const committed = commitSmartNoteState(args.db, {
                    phase: "network failure",
                    expected,
                    leaseHeld,
                    write: () => {
                        if (result.persistent) {
                            markSmartNoteCompilationFailure(
                                args.db,
                                note.id,
                                runFinishedAt,
                                MAX_FAILURES_BEFORE_REAUTHOR,
                                result.error,
                                true,
                                undefined,
                                result.retryAt,
                                result.uncheckable,
                            );
                        } else {
                            markCompiledCheckNetworkFailure(
                                args.db,
                                note.id,
                                runFinishedAt,
                                MAX_FAILURES_BEFORE_REAUTHOR,
                                result.retryAt,
                            );
                        }
                    },
                });
                if (committed) networkFailed++;
            } else {
                const committed = commitSmartNoteState(args.db, {
                    phase: "logic failure",
                    expected,
                    leaseHeld,
                    write: () => {
                        markCompiledCheckLogicFailure(
                            args.db,
                            note.id,
                            runFinishedAt,
                            MAX_FAILURES_BEFORE_REAUTHOR,
                        );
                    },
                });
                if (committed) failed++;
            }
        } finally {
            clearTimeout(timer);
            args.signal?.removeEventListener("abort", abortFromCaller);
        }
    }

    return { ran, surfaced, failed, networkFailed };
}

function hostGeneratedReadyReason(noteId: number, manifestJson: string | null): string {
    const manifest = parseSmartNoteManifest(manifestJson);
    const signal = manifest.signals?.[0] ?? manifest.summary ?? "compiled check returned met=true";
    return `Smart note #${noteId}: ${signal}`.slice(0, 240);
}
