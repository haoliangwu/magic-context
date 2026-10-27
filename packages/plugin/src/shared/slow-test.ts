import { test } from "bun:test";

export const slowLane = process.env.MC_SLOW_TESTS === "1";
export const slowPrefix = "[slow] ";

function register(name: string, run: () => void | Promise<void>, timeout: number) {
    if (process.env.MC_SLOW_TEST_LIST === "1")
        console.log(`SLOW_SELECTION ${JSON.stringify(name)}`);
    test(name, run, timeout);
}

/** Run the same behavioral oracle at unit scale or at its full scheduled scale. */
export function scaleTest(
    name: string,
    run: (slow: boolean) => void | Promise<void>,
    timeout = 30_000,
) {
    register(`${slowLane ? slowPrefix : ""}${name}`, () => run(slowLane), timeout);
}

/** Measurement calibration and production-duration sentinels have no fast substitute. */
export function slowOnlyTest(name: string, run: () => void | Promise<void>, timeout = 30_000) {
    if (slowLane) register(`${slowPrefix}${name}`, run, timeout);
}
