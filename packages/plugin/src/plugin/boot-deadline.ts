import { startBootDeadline } from "../shared/off-thread-migration-clock";

export type BootPhaseResult<T> =
    | { status: "completed"; value: T; elapsedMs: number }
    | {
          status: "timed_out";
          elapsedMs: number;
          /**
           * The still-running operation. A slow-but-healthy phase must be
           * adopted when it finally settles rather than leaving the process
           * fail-closed for its lifetime.
           */
          pending: Promise<T>;
      };

export interface BootBudget {
    readonly startedAt: number;
    readonly deadlineAt: number;
    readonly totalMs: number;
}

export interface BootPhaseDiagnostics {
    configMs: number;
    conflictMs: number;
    guardMs: number;
    openMs: number;
    migrateMs: number;
    hooksMs: number;
    rpcMs: number;
    postMs: number;
    totalMs: number;
    budgetMs: number;
    deadlinePhase: string | null;
}

export function formatBootEnteringBreadcrumb(pid: number, directory: string): string {
    return `[magic-context] boot: entering pid=${pid} dir=${directory}`;
}

export function emitBootEnteringBreadcrumb(
    pid: number,
    directory: string,
    report: (message: string) => void,
    flush: () => void,
): void {
    report(formatBootEnteringBreadcrumb(pid, directory));
    flush();
}

export function formatBootPhaseDiagnostics(timings: BootPhaseDiagnostics): string {
    return `[magic-context] boot phases: config=${Math.round(timings.configMs)}ms conflict=${Math.round(timings.conflictMs)}ms guard=${Math.round(timings.guardMs)}ms open=${Math.round(timings.openMs)}ms migrate=${Math.round(timings.migrateMs)}ms hooks=${Math.round(timings.hooksMs)}ms rpc=${Math.round(timings.rpcMs)}ms post=${Math.round(timings.postMs)}ms total=${Math.round(timings.totalMs)}ms budget=${timings.budgetMs}ms deadline_phase=${timings.deadlinePhase ?? "none"}`;
}

export function createBootBudget(totalMs: number, startedAt = performance.now()): BootBudget {
    const boundedTotalMs = Math.max(0, totalMs);
    return {
        startedAt,
        deadlineAt: startedAt + boundedTotalMs,
        totalMs: boundedTotalMs,
    };
}

export function remainingBootBudgetMs(budget: BootBudget, now = performance.now()): number {
    return Math.max(0, budget.deadlineAt - now);
}

/**
 * Keep an awaited plugin boot phase from holding OpenCode's plugin loader forever.
 * The timed-out operation is observed to prevent a late rejection from becoming
 * unhandled, but startup proceeds immediately because JavaScript promises cannot
 * cancel arbitrary plugin work.
 */
export async function runBootPhaseWithDeadline<T>(
    phase: string,
    operation: () => Promise<T>,
    timeoutMs: number,
    report: (message: string) => void,
    deadlineDescription = `its ${timeoutMs}ms deadline`,
): Promise<BootPhaseResult<T>> {
    const startedAt = performance.now();
    // Schema migrations run on a worker thread; their time is not counted here,
    // so a long first-start upgrade still finishes with Magic Context enabled.
    const deadline = startBootDeadline(timeoutMs, () =>
        report(
            `[magic-context] boot phase '${phase}' reached ${deadlineDescription} while a schema migration runs off the main thread; waiting for the migration, which does not count against the deadline`,
        ),
    );
    const running = Promise.resolve().then(operation);
    const timeout = deadline.expired.then<BootPhaseResult<T>>(() => {
        const elapsedMs = performance.now() - startedAt;
        report(
            `[magic-context] boot phase '${phase}' exceeded ${deadlineDescription}; host startup will continue with Magic Context fail-closed`,
        );
        return { status: "timed_out", elapsedMs, pending: running };
    });
    const completed = running.then<BootPhaseResult<T>>((value) => ({
        status: "completed",
        value,
        elapsedMs: performance.now() - startedAt,
    }));

    try {
        const result = await Promise.race([completed, timeout]);
        if (result.status === "timed_out") {
            void running.catch((error) => {
                report(
                    `[magic-context] boot phase '${phase}' rejected after its deadline: ${error instanceof Error ? error.message : String(error)}`,
                );
            });
        }
        return result;
    } finally {
        deadline.cancel();
    }
}

/** Run one awaited phase against the time left in a single server-wide budget. */
export function runBootPhaseWithinBudget<T>(
    budget: BootBudget,
    phase: string,
    operation: () => Promise<T>,
    report: (message: string) => void,
): Promise<BootPhaseResult<T>> {
    const remainingMs = remainingBootBudgetMs(budget);
    if (remainingMs <= 0) {
        report(
            `[magic-context] boot phase '${phase}' exceeded the whole-server ${budget.totalMs}ms budget; host startup will continue with Magic Context fail-closed`,
        );
        // Start late recovery in a later task so the plugin can return first even
        // if the operation has a synchronous prefix. The pending promise remains
        // available for the caller to install the recovered hooks after timeout.
        const pending = new Promise<T>((resolve, reject) => {
            setTimeout(() => {
                Promise.resolve().then(operation).then(resolve, reject);
            }, 0);
        });
        return Promise.resolve({ status: "timed_out", elapsedMs: 0, pending });
    }
    return runBootPhaseWithDeadline(
        phase,
        operation,
        remainingMs,
        report,
        `the whole-server ${budget.totalMs}ms budget`,
    );
}
