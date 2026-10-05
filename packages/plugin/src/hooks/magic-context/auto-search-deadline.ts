export const AUTO_SEARCH_TIMEOUT_MS = 3_000;

/**
 * Preparation and search share one deadline. Check elapsed time as well as
 * the timer: a synchronous SQLite call can prevent an overdue timer from
 * firing before the search promise resolves. Checkpoints after preparation or
 * embedding abort expired work before its next synchronous database scan;
 * overdue search results are discarded before hint persistence.
 */
export async function withAutoSearchDeadline<T>(
    operation: (signal: AbortSignal, checkDeadline: () => boolean) => Promise<T>,
    startedAt = performance.now(),
): Promise<T | null> {
    const deadline = startedAt + AUTO_SEARCH_TIMEOUT_MS;
    const remaining = deadline - performance.now();
    if (remaining <= 0) return null;
    const controller = new AbortController();
    const checkDeadline = (): boolean => {
        if (!controller.signal.aborted && performance.now() >= deadline) controller.abort();
        return controller.signal.aborted;
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<null>((resolve) => {
        timer = setTimeout(() => {
            resolve(null);
            controller.abort();
        }, remaining);
    });
    try {
        return await Promise.race([
            Promise.resolve()
                .then(() => operation(controller.signal, checkDeadline))
                .then((result) => {
                    if (checkDeadline()) {
                        return null;
                    }
                    return result;
                }),
            timeout,
        ]);
    } finally {
        if (timer !== undefined) clearTimeout(timer);
    }
}
