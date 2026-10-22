import { expect, spyOn } from "bun:test";
import { AUTO_SEARCH_TIMEOUT_MS } from "./auto-search-deadline";

// Only the operation deadline is controlled. Worker startup and loop callbacks
// stay real, so the blocked-worker tests also exercise owner-thread progress.
export function deadlineClock() {
    expect(AUTO_SEARCH_TIMEOUT_MS).toBe(1_000);
    let now = 0;
    let expire: (() => void) | undefined;
    const realTimeout = globalThis.setTimeout;
    const clock = spyOn(performance, "now").mockImplementation(() => now);
    const schedule = ((callback: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) => {
        if (ms !== AUTO_SEARCH_TIMEOUT_MS) return realTimeout(callback, ms, ...args);
        const handle = realTimeout(() => {}, 0);
        clearTimeout(handle);
        expire = () => callback(...args);
        return handle;
    }) as typeof setTimeout;
    const timer = spyOn(globalThis, "setTimeout").mockImplementation(schedule);
    return {
        expire: () => {
            expect(expire).toBeDefined();
            now = AUTO_SEARCH_TIMEOUT_MS;
            expire?.();
        },
        restore: () => {
            timer.mockRestore();
            clock.mockRestore();
        },
    };
}

export const nextLoopTurn = () => new Promise<void>((resolve) => setImmediate(resolve));
