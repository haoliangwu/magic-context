import { expect, it } from "bun:test";
import { AUTO_SEARCH_TIMEOUT_MS, withAutoSearchDeadline } from "./auto-search-deadline";

it("rejects an overdue synchronous result even before its timer fires", async () => {
    let signal: AbortSignal | undefined;
    const result = await withAutoSearchDeadline(
        async (currentSignal) => {
            signal = currentSignal;
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30);
            return "late hint";
        },
        performance.now() - AUTO_SEARCH_TIMEOUT_MS + 10,
    );
    expect(result).toBeNull();
    expect(signal?.aborted).toBe(true);
});

it("does not start search after preparation has already exhausted the budget", async () => {
    let calls = 0;
    const result = await withAutoSearchDeadline(
        async () => {
            calls++;
            return "hint";
        },
        performance.now() - AUTO_SEARCH_TIMEOUT_MS - 1,
    );
    expect(result).toBeNull();
    expect(calls).toBe(0);
});

it("returns successful search results within the shared deadline", async () => {
    expect(await withAutoSearchDeadline(async () => ["hint"])).toEqual(["hint"]);
});

it("checkpoints abort overdue continuations before the timeout timer fires", async () => {
    let observedAborted = false;
    const result = await withAutoSearchDeadline(
        async (signal, checkDeadline) => {
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30);
            expect(checkDeadline()).toBe(true);
            observedAborted = signal.aborted;
            return "late hint";
        },
        performance.now() - AUTO_SEARCH_TIMEOUT_MS + 10,
    );
    expect(result).toBeNull();
    expect(observedAborted).toBe(true);
});
