import { expect, test } from "bun:test";
import { isProjectMemoryEnabled, readEnabledProjectMemories } from "./memory-enabled";

test("project memory is enabled by default and the gate preserves enabled rows", () => {
    const rows = [{ content: "Project constraint" }];
    for (const enabled of [undefined, true]) {
        expect(isProjectMemoryEnabled(enabled)).toBe(true);
        expect(readEnabledProjectMemories(enabled, () => rows)).toBe(rows);
    }
    expect(isProjectMemoryEnabled(false)).toBe(false);
    expect(
        readEnabledProjectMemories(false, () => {
            throw new Error("disabled read");
        }),
    ).toEqual([]);
});
