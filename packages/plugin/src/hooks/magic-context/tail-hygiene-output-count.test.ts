import { expect, test } from "bun:test";
import { stableStringify } from "../../shared/stable-json";
import {
    countReclaimableToolOutputs,
    currentReclaimableToolOutputCount,
    rememberCurrentToolOutputCount,
} from "./tail-hygiene-output-count";

test("current output counts use complete eligible measurements and do not change frozen JSON", () => {
    const prefix = [{ kind: "toolOutput", uTokens: 5 }];
    const baseline = { baselineParts: prefix, baselineU: 5 };
    const before = JSON.stringify(baseline);
    const stableBefore = stableStringify(baseline);
    const current = {
        parts: [
            ...prefix,
            { kind: "toolOutput", uTokens: 10 },
            { kind: "toolOutput", uTokens: 0 },
            { kind: "toolInput", uTokens: 20 },
            { kind: "excluded", uTokens: 0 },
        ],
    };
    expect(countReclaimableToolOutputs(current.parts)).toBe(2);
    rememberCurrentToolOutputCount(baseline, current);
    expect(currentReclaimableToolOutputCount(baseline)).toBe(2);
    expect(currentReclaimableToolOutputCount({ ...baseline })).toBe(2);
    expect(JSON.stringify(baseline)).toBe(before);
    expect(stableStringify(baseline)).toBe(stableBefore);
    expect(Object.keys(baseline)).toEqual(["baselineParts", "baselineU"]);
    expect(currentReclaimableToolOutputCount(JSON.parse(before))).toBe(0);
    expect(currentReclaimableToolOutputCount(undefined)).toBe(0);
});
