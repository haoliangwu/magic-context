import { afterEach, describe, expect, test } from "bun:test";
import {
    __resetOffThreadMigrationClockForTests,
    __setOffThreadMigrationClockForTests,
    beginOffThreadMigration,
    startBootDeadline,
} from "./off-thread-migration-clock";

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function expiredWithin(promise: Promise<void>, ms: number): Promise<boolean> {
    return Promise.race([promise.then(() => true), sleep(ms).then(() => false)]);
}

function createFakeClock() {
    let now = 0;
    let nextTimerId = 0;
    const timers = new Map<number, { at: number; callback: () => void }>();
    let timerCountWaiter: { count: number; resolve: () => void } | undefined;

    return {
        now: () => now,
        setTimeout: (callback: () => void, delayMs: number) => {
            const id = ++nextTimerId;
            timers.set(id, { at: now + Math.max(0, delayMs), callback });
            if (timerCountWaiter?.count === timers.size) {
                timerCountWaiter.resolve();
                timerCountWaiter = undefined;
            }
            return () => {
                timers.delete(id);
            };
        },
        advanceBy: (ms: number) => {
            now += ms;
            while (true) {
                const next = [...timers.entries()].sort(
                    (left, right) => left[1].at - right[1].at,
                )[0];
                if (!next || next[1].at > now) return;
                timers.delete(next[0]);
                next[1].callback();
            }
        },
        waitForTimerCount: (count: number) => {
            if (timers.size === count) return Promise.resolve();
            return new Promise<void>((resolve) => {
                timerCountWaiter = { count, resolve };
            });
        },
    };
}

async function isSettled(promise: Promise<void>): Promise<boolean> {
    return Promise.race([promise.then(() => true), Promise.resolve(false)]);
}

describe("boot deadline that excludes off-thread migration time", () => {
    afterEach(() => __resetOffThreadMigrationClockForTests());

    test("expires on time when no migration runs", async () => {
        const deadline = startBootDeadline(30);
        expect(await expiredWithin(deadline.expired, 500)).toBe(true);
    });

    test("does not count migration time and resumes with only the pre-migration time spent", async () => {
        const clock = createFakeClock();
        __setOffThreadMigrationClockForTests(clock);
        let deferred = 0;
        let signalDeferred!: () => void;
        const wasDeferred = new Promise<void>((resolve) => {
            signalDeferred = resolve;
        });
        const deadline = startBootDeadline(40, () => {
            deferred += 1;
            signalDeferred();
        });
        clock.advanceBy(15);
        const end = beginOffThreadMigration();
        clock.advanceBy(25);
        await wasDeferred;
        expect(deferred).toBe(1);

        clock.advanceBy(1_000_000);
        expect(await isSettled(deadline.expired)).toBe(false);

        const nextTimer = clock.waitForTimerCount(1).then(() => "scheduled" as const);
        end();
        expect(
            await Promise.race([nextTimer, deadline.expired.then(() => "expired" as const)]),
        ).toBe("scheduled");

        clock.advanceBy(24);
        expect(await isSettled(deadline.expired)).toBe(false);
        clock.advanceBy(1);
        await deadline.expired;
    });

    test("time between migrations still counts", async () => {
        const clock = createFakeClock();
        __setOffThreadMigrationClockForTests(clock);
        const deadline = startBootDeadline(60);
        clock.advanceBy(40);
        const end = beginOffThreadMigration();
        clock.advanceBy(80);
        expect(await isSettled(deadline.expired)).toBe(false);

        const nextTimer = clock.waitForTimerCount(1).then(() => "scheduled" as const);
        end();
        expect(
            await Promise.race([nextTimer, deadline.expired.then(() => "expired" as const)]),
        ).toBe("scheduled");

        clock.advanceBy(19);
        expect(await isSettled(deadline.expired)).toBe(false);
        clock.advanceBy(1);
        await deadline.expired;
    });

    test("a cancelled deadline never expires", async () => {
        const deadline = startBootDeadline(20);
        deadline.cancel();
        expect(await expiredWithin(deadline.expired, 100)).toBe(false);
    });
});
