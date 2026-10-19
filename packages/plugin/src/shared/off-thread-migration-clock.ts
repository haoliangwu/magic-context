/**
 * Boot deadlines that do not count time spent migrating the schema on a worker
 * thread.
 *
 * Plugin startup bounds the storage open with a timer so a stuck open cannot
 * hold the host's plugin loader forever. When migrations ran on the main thread
 * that timer could not fire while a migration body ran, so in effect migration
 * time never counted against the deadline, and a long first-start upgrade still
 * ended with tools registered. Migrations now run on a worker thread and the
 * timer stays live, so without this clock a long upgrade would trip the
 * deadline and start the host without Magic Context tools. Excluding the
 * worker's busy time keeps the previous outcome while the host's event loop
 * keeps serving requests. Waits for another process's write lock still count,
 * exactly as before, because the worker reports them as idle time.
 */

let activeMigrations = 0;
let activeSince = 0;
let accumulatedMs = 0;
let idleWaiters: Array<() => void> = [];

interface TestClock {
    now(): number;
    setTimeout(callback: () => void, delayMs: number): () => void;
}

let testClock: TestClock | undefined;

function now(): number {
    return testClock?.now() ?? performance.now();
}

function scheduleTimeout(callback: () => void, delayMs: number): () => void {
    if (testClock) return testClock.setTimeout(callback, delayMs);
    const timer = setTimeout(callback, delayMs);
    return () => clearTimeout(timer);
}

/** Total milliseconds any off-thread migration has been running, up to `now`. */
export function offThreadMigrationMs(at = now()): number {
    return accumulatedMs + (activeMigrations > 0 ? Math.max(0, at - activeSince) : 0);
}

export function isOffThreadMigrationRunning(): boolean {
    return activeMigrations > 0;
}

/**
 * Mark the start of off-thread migration work. The returned function marks its
 * end; calling it more than once has no further effect.
 */
export function beginOffThreadMigration(): () => void {
    if (activeMigrations === 0) activeSince = now();
    activeMigrations += 1;
    let ended = false;
    return () => {
        if (ended) return;
        ended = true;
        activeMigrations -= 1;
        if (activeMigrations > 0) return;
        accumulatedMs += Math.max(0, now() - activeSince);
        const waiters = idleWaiters;
        idleWaiters = [];
        for (const wake of waiters) wake();
    };
}

function whenOffThreadMigrationIdle(): Promise<void> {
    if (activeMigrations === 0) return Promise.resolve();
    return new Promise((resolve) => idleWaiters.push(resolve));
}

export interface BootDeadlineTimer {
    /** Resolves once `timeoutMs` of non-migration time has passed. */
    readonly expired: Promise<void>;
    cancel(): void;
}

/**
 * Start a deadline that expires after `timeoutMs` of elapsed time, not counting
 * time during which an off-thread migration was running. `onDeferred` is called
 * once, the first time the deadline would have expired but a migration was
 * still running.
 */
export function startBootDeadline(timeoutMs: number, onDeferred?: () => void): BootDeadlineTimer {
    const startedAt = now();
    const migratedAtStart = offThreadMigrationMs(startedAt);
    const budgetMs = Math.max(0, timeoutMs);
    let cancelTimer: (() => void) | undefined;
    let cancelled = false;
    let deferredReported = false;
    let resolveExpired!: () => void;
    const expired = new Promise<void>((resolve) => {
        resolveExpired = resolve;
    });

    const remainingMs = (): number => {
        const currentTime = now();
        const countedMs =
            currentTime - startedAt - (offThreadMigrationMs(currentTime) - migratedAtStart);
        return budgetMs - countedMs;
    };

    const check = (): void => {
        cancelTimer = undefined;
        if (cancelled) return;
        if (isOffThreadMigrationRunning()) {
            if (!deferredReported) {
                deferredReported = true;
                onDeferred?.();
            }
            void whenOffThreadMigrationIdle().then(check);
            return;
        }
        const left = remainingMs();
        if (left > 0) {
            cancelTimer = scheduleTimeout(check, left);
            return;
        }
        resolveExpired();
    };

    cancelTimer = scheduleTimeout(check, budgetMs);
    return {
        expired,
        cancel: () => {
            cancelled = true;
            cancelTimer?.();
            cancelTimer = undefined;
        },
    };
}

/** Inject deterministic time and timers in tests; production uses host APIs. */
export function __setOffThreadMigrationClockForTests(clock?: TestClock): void {
    testClock = clock;
}

/** Test seam: forget accumulated migration time between isolated tests. */
export function __resetOffThreadMigrationClockForTests(): void {
    activeMigrations = 0;
    activeSince = 0;
    accumulatedMs = 0;
    testClock = undefined;
    const waiters = idleWaiters;
    idleWaiters = [];
    for (const wake of waiters) wake();
}
