/**
 * Background maintenance waits after the first plugin construction so a
 * sibling process can finish its startup reads and migrations before writers
 * begin. This is intentionally fixed rather than user-configurable.
 */
export const BOOT_QUIET_MS = 120_000;

let bootQuietUntilMs = 0;

export function beginBootQuietPeriod(now = Date.now()): void {
    if (bootQuietUntilMs === 0) bootQuietUntilMs = now + BOOT_QUIET_MS;
}

export function bootQuietRemainingMs(now = Date.now()): number {
    return Math.max(0, bootQuietUntilMs - now);
}

export function scheduleAfterBootQuiet(
    task: () => void,
    additionalDelayMs = 0,
): ReturnType<typeof setTimeout> {
    const timer = inRootAsyncContext(() =>
        setTimeout(task, bootQuietRemainingMs() + Math.max(0, additionalDelayMs)),
    );
    (timer as { unref?: () => void }).unref?.();
    return timer;
}

/** Test seam for deterministic fake-timer coverage. */
export function setBootQuietPeriodForTests(startAtMs: number | null): void {
    bootQuietUntilMs = startAtMs === null ? 0 : startAtMs + BOOT_QUIET_MS;
}

import { inRootAsyncContext } from "../shared/sqlite";
