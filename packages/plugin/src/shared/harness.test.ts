import { afterEach, describe, expect, it } from "bun:test";

import { _resetHarnessForTesting, getHarness, setHarness } from "./harness";

afterEach(() => {
    _resetHarnessForTesting();
});

describe("harness identity", () => {
    it("defaults to opencode before any plugin sets it", () => {
        _resetHarnessForTesting();
        expect(getHarness()).toBe("opencode");
        expect(setHarness).toBeDefined();
    });

    it("locks the first value set for the process", () => {
        setHarness("dsh");
        expect(getHarness()).toBe("dsh");
    });

    it("treats repeated same-value calls as a no-op", () => {
        setHarness("pi");
        setHarness("pi");
        expect(getHarness()).toBe("pi");
    });

    it("throws when a different value is set after locking", () => {
        setHarness("omp");
        expect(() => setHarness("dsh")).toThrow(/harness already locked to "omp"/);
        expect(getHarness()).toBe("omp");
    });

    it("accepts every shipping harness id", () => {
        for (const id of ["opencode", "opencode2", "pi", "omp", "dsh"] as const) {
            _resetHarnessForTesting();
            setHarness(id);
            expect(getHarness()).toBe(id);
        }
    });
});
