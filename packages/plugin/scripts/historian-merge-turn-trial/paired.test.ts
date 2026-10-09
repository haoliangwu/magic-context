import { expect, test } from "bun:test";
import { hash, normalize } from "./core";
import { armOrder, exactDuplicates, GENERATION, pairedPrompts, pairedRoot, validateTurn } from "./paired";

const full = "α\r\n<project-memory>old &amp; fact\n</project-memory>\r\nnew";
const stripped = "α\r\n\r\nnew";
const input = { index: 0, session: "old", before: 10, prompt: stripped, promptHash: hash(stripped), originalPromptHash: hash(full), blockHash: hash("<project-memory>old &amp; fact\n</project-memory>") };
const row = { child_session: "old", created_at: 10, user_prompt: full };
test("paired full prompt preserves recorded bytes and stripped prompt is unchanged", () => {
    expect(pairedPrompts(input, row)).toEqual({ F: full, S: stripped });
});
test("paired control rejects a changed original prompt hash", () => {
    expect(() => pairedPrompts({ ...input, originalPromptHash: hash(full + "\n") }, row)).toThrow("Recorded prompt identity changed");
});
test("paired control rejects changed stripped bytes, block hash and cohort identity", () => {
    expect(() => pairedPrompts({ ...input, prompt: stripped + "\n" }, row)).toThrow();
    expect(() => pairedPrompts({ ...input, blockHash: "wrong" }, row)).toThrow();
    expect(() => pairedPrompts(input, { ...row, created_at: 11 })).toThrow();
    expect(() => pairedPrompts(input, { ...row, child_session: "other" })).toThrow();
    expect(() => pairedRoot("/tmp/live/store")).toThrow();
});
test("pair order counterbalances forty cases without changing membership", () => {
    const orders = Array.from({ length: 40 }, (_, i) => armOrder(i));
    expect(orders.filter(a => a[0] === "F").length).toBe(20);
    expect(orders.every(a => a.length === 2 && new Set(a).size === 2)).toBe(true);
});
test("provider validation rejects wrong settings and incomplete steps", () => {
    const usage = { input_tokens: 5, output_tokens: 2 };
    const result = { runId: "r", model: "google/antigravity-gemini-3.8-flash", generation: GENERATION, promptHash: hash(full), systemHash: hash("system"), usage,
        events: [{ type: "step_finished", finish_reason: "stop", usage }, { type: "run_finished", reason: "completed" }] };
    expect(() => validateTurn(result, full, "system")).not.toThrow();
    expect(() => validateTurn({ ...result, generation: { ...GENERATION, temperature: 1 } }, full, "system")).toThrow();
    expect(() => validateTurn({ ...result, events: [] }, full, "system")).toThrow();
    expect(() => validateTurn({ ...result, usage: {} }, full, "system")).toThrow();
});
test("exact duplicate insert simulation includes earlier pool and within-run repeats", () => {
    expect(exactDuplicates([{ content: " OLD  fact " }, { content: "new" }, { content: "New" }], [{ content: "old fact" }], normalize)).toBe(2);
});
