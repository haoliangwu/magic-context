import { afterAll, afterEach, expect, spyOn, test } from "bun:test";
import * as logger from "../../shared/logger";
import * as timing from "./transform-stage-logger";

const log = spyOn(logger, "sessionLog");
afterEach(() => log.mockClear());
afterAll(() => log.mockRestore());

// If the summary wrapper is absent, run directly to exercise the legacy per-stage logger.
const pass = <T>(run: () => Promise<T>): Promise<T> =>
    (timing as Partial<typeof timing>).withTransformTimingSummary?.(run) ?? run();

test("35 normal stage timings produce one summary line per pass", async () => {
    await pass(async () => {
        for (let stage = 0; stage < 35; stage++)
            timing.logTransformTiming("normal", `stage${stage}`, performance.now());
    });
    expect(log.mock.calls).toHaveLength(1);
    expect(log.mock.calls[0]?.[1]).toContain("transform stages:");
    expect(log.mock.calls[0]?.[1]).toContain("stage34=");
    expect(log.mock.calls[0]?.[1]).toContain("slow>=100ms=[]");
});

test("a slow stage keeps its own line and is called out in the pass summary", async () => {
    await pass(async () => {
        timing.logTransformTiming("slow", "quick", performance.now());
        timing.logTransformTiming("slow", "database", performance.now() - 150, "rows=42");
    });
    expect(log.mock.calls).toHaveLength(2);
    expect(log.mock.calls[0]?.[1]).toContain("transform stage: stage=database");
    expect(log.mock.calls[0]?.[1]).toContain("rows=42");
    expect(log.mock.calls[1]?.[1]).toContain("slow>=100ms=[database]");
});

test("overlapping and failed passes each flush only their own timings", async () => {
    await Promise.all([
        pass(async () => {
            timing.logTransformTiming("one", "first", performance.now());
            await Promise.resolve();
        }),
        pass(async () => {
            timing.logTransformTiming("two", "second", performance.now());
            throw new Error("refused");
        }).catch(() => {}),
    ]);
    expect(log.mock.calls).toHaveLength(2);
    expect(log.mock.calls.find(([id]) => id === "one")?.[1]).toContain("first=");
    expect(log.mock.calls.find(([id]) => id === "one")?.[1]).not.toContain("second=");
    expect(log.mock.calls.find(([id]) => id === "two")?.[1]).toContain("second=");
});
