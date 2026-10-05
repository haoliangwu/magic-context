import {
    isTransientSqliteError,
    withoutSqliteTransformPass,
    withSqliteBackgroundWriter,
} from "./sqlite";

/** Drain committed slices without monopolizing the event loop or borrowing a
 * foreground turn's lock-wait budget. A busy slice defers to the next timer tick. */
export async function drainBackgroundBatches(
    step: () => boolean,
    options: { budgetMs?: number; now?: () => number; yieldFn?: () => Promise<void> } = {},
): Promise<number> {
    const now = options.now ?? (() => performance.now());
    const deadline = now() + (options.budgetMs ?? 2000);
    const yieldFn =
        options.yieldFn ?? (() => new Promise<void>((resolve) => setTimeout(resolve, 0)));
    let batches = 0;
    while (now() < deadline) {
        try {
            if (!withoutSqliteTransformPass(() => withSqliteBackgroundWriter(step))) break;
        } catch (error) {
            if (isTransientSqliteError(error)) break;
            throw error;
        }
        batches++;
        await yieldFn();
    }
    return batches;
}
