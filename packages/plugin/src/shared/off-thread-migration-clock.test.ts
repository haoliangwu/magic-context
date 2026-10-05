import { afterEach, describe, expect, test } from "bun:test";
import {
    __resetOffThreadMigrationClockForTests,
    beginOffThreadMigration,
    startBootDeadline,
} from "./off-thread-migration-clock";

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function expiredWithin(promise: Promise<void>, ms: number): Promise<boolean> {
    return Promise.race([promise.then(() => true), sleep(ms).then(() => false)]);
}

describe("boot deadline that excludes off-thread migration time", () => {
    afterEach(() => __resetOffThreadMigrationClockForTests());

    test("expires on time when no migration runs", async () => {
        const deadline = startBootDeadline(30);
        expect(await expiredWithin(deadline.expired, 500)).toBe(true);
    });

    test("does not expire while a migration runs, and resumes counting afterwards", async () => {
        let deferred = 0;
        const deadline = startBootDeadline(40, () => {
            deferred += 1;
        });
        const end = beginOffThreadMigration();
        expect(await expiredWithin(deadline.expired, 150)).toBe(false);
        expect(deferred).toBe(1);

        const endedAt = performance.now();
        end();
        await deadline.expired;
        // Only the few milliseconds before the migration began were counted, so
        // nearly the whole 40ms budget is still left once it ends.
        expect(performance.now() - endedAt).toBeGreaterThanOrEqual(25);
    });

    test("time between migrations still counts", async () => {
        const deadline = startBootDeadline(60);
        await sleep(40);
        const end = beginOffThreadMigration();
        await sleep(80);
        end();
        const endedAt = performance.now();
        await deadline.expired;
        expect(performance.now() - endedAt).toBeLessThan(45);
    });

    test("a cancelled deadline never expires", async () => {
        const deadline = startBootDeadline(20);
        deadline.cancel();
        expect(await expiredWithin(deadline.expired, 100)).toBe(false);
    });
});
