import { expect, test } from "bun:test";
import { drainBackgroundBatches } from "./background-batch-drain";

test("background drain yields after each committed slice and resumes after its tick budget", async () => {
    let clock = 0;
    let remaining = 10;
    let yields = 0;
    const options = {
        budgetMs: 3,
        now: () => clock,
        yieldFn: async () => {
            yields++;
            clock++;
        },
    };
    const step = () => {
        if (remaining === 0) return false;
        remaining--;
        return true;
    };
    expect(await drainBackgroundBatches(step, options)).toBe(3);
    expect(yields).toBe(3);
    expect(remaining).toBe(7);
    expect(await drainBackgroundBatches(step, { ...options, budgetMs: 20 })).toBe(7);
    expect(yields).toBe(10);
    expect(remaining).toBe(0);
});

test("a busy background slice defers without rerunning a partially executed callback", async () => {
    let attempts = 0;
    expect(
        await drainBackgroundBatches(() => {
            attempts++;
            throw Object.assign(new Error("busy"), { code: "SQLITE_BUSY" });
        }),
    ).toBe(0);
    expect(attempts).toBe(1);
});
