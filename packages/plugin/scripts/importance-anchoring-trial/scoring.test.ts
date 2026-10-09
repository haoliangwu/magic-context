import { expect, test } from "bun:test";
import { hash } from "./core";
import { pairedChanges, scoringCell } from "./scoring";

const refs = (scored: number, total: number) => Array.from({ length: total }, (_, i) => `<compartment title="ref ${i}"${i < scored ? ' importance="74"' : ""}><p1>work</p1></compartment>`).join("\n");
const prompt = `<compartment_examples_from_other_projects>${refs(3, 3)}</compartment_examples_from_other_projects>\n<session_references>${refs(3, 7)}</session_references>\n<new_messages>unchanged $& transcript</new_messages>`;
const input = { system: "shipped system", systemHash: hash("shipped system"), prompts: { E: prompt }, promptHashes: { E: hash(prompt) } };

test("E and E2 repeat the saved system; F changes only system, never the E user prompt", () => {
    expect(scoringCell(input, "E", "revised system")).toEqual({ prompt, system: "shipped system" });
    expect(scoringCell(input, "E2", "revised system")).toEqual({ prompt, system: "shipped system" });
    expect(scoringCell(input, "F", "revised system")).toEqual({ prompt, system: "revised system" });
});
test("scoring trial rejects stale saved hashes", () => {
    expect(() => scoringCell({ ...input, system: "changed" }, "E", "revised")).toThrow("hash mismatch");
    expect(() => scoringCell({ ...input, prompts: { E: `${prompt}changed` } }, "F", "revised")).toThrow("hash mismatch");
});
test("scoring trial rejects a scored recent reference even with a valid saved hash", () => {
    const altered = prompt.replace('<compartment title="ref 6">', '<compartment title="ref 6" importance="74">');
    expect(() => scoringCell({ ...input, prompts: { E: altered }, promptHashes: { E: hash(altered) } }, "F", "revised")).toThrow("four unscored recent");
});
test("scoring trial rejects an unchanged system intervention", () => {
    expect(() => scoringCell(input, "F", input.system)).toThrow("systems must differ");
});
test("paired noise uses signed and absolute deltas, not proximity to historical scores", () => {
    const changes = pairedChanges([50, 72, 85], [53, 71, 85]);
    expect(changes.delta.min).toBe(-1);
    expect(changes.delta.max).toBe(3);
    expect(changes.delta.mean).toBeCloseTo(2 / 3);
    expect(changes.meanAbsoluteDelta).toBeCloseTo(4 / 3);
    expect(changes.identical).toBe(1);
    expect(changes.within2).toBe(2);
});
