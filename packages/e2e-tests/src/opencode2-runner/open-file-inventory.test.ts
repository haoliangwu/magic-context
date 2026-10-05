import { expect, test } from "bun:test";
import { resampleTransientInventory } from "./spawn";

test("open-file inspection resamples a partial inventory without accepting it", () => {
    const samples = [{ status: 1, paths: ["expired-child"] }, { status: 0, paths: ["live-host"] }];
    let calls = 0;
    expect(resampleTransientInventory(() => samples[calls++]!)).toEqual(samples[1]!);
    expect(calls).toBe(2);
});

test("open-file inspection bounds repeated partial inventories", () => {
    let calls = 0;
    expect(resampleTransientInventory(() => { calls++; return { status: 1 }; }).status).toBe(1);
    expect(calls).toBe(3);
});

test("open-file inspection does not retry process or command failures", () => {
    for (const status of [0, 2, null]) {
        let calls = 0;
        expect(resampleTransientInventory(() => { calls++; return { status }; }).status).toBe(status);
        expect(calls).toBe(1);
    }
});
