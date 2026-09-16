import { expect, test } from "bun:test";
import { FoldOwner, foldDigest } from "./owner";

function fixture() {
    const data = new Map<string, unknown>();
    const storage = {
        get: async (key: string) => structuredClone(data.get(key)),
        set: async (key: string, value: unknown) => {
            data.set(key, structuredClone(value));
        },
    };
    const owner = new FoldOwner(storage);
    let materializations = 0;
    const supply = (watermark: number, runningCut?: number) =>
        owner.supply({
            sessionID: "s",
            watermark,
            runningCut,
            materialize: () => `baseline ${++materializations}`,
        });
    const rendered = (summary: string) => ({
        id: "cut",
        role: "user",
        content: [
            {
                type: "text",
                text: `<conversation-checkpoint><summary>${summary}</summary><recent-context>host recent</recent-context></conversation-checkpoint>`,
            },
        ],
    });
    return { storage, owner, supply, rendered, count: () => materializations };
}

test("R3a same-watermark provisional firing replays submitted SHA without materializing", async () => {
    const f = fixture();
    const first = await f.supply(12);
    expect((await f.supply(12)).submittedSha).toBe(first.submittedSha);
    expect(f.count()).toBe(1);
});
test("R3a later provisional watermark supersedes the earlier fold", async () => {
    const f = fixture();
    const first = await f.supply(12);
    const second = await f.supply(18);
    expect(second.submittedSha).not.toBe(first.submittedSha);
    expect((await f.owner.read("s"))?.watermark).toBe(18);
    expect(f.count()).toBe(2);
});
test("R3a boot rebinds persisted provisional to actual cut and pins render separately", async () => {
    const f = fixture();
    const pending = await f.supply(12);
    const restarted = new FoldOwner(f.storage);
    const hard: string[] = [];
    const rendered = f.rendered(pending.submitted);
    const bound = await restarted.observe({
        sessionID: "s",
        cutSeq: 29,
        summary: pending.submitted,
        rendered,
        onHard: (reason) => hard.push(reason),
    });
    expect(bound.cutSeq).toBe(29);
    expect(bound.submittedSha).toBe(foldDigest(pending.submitted));
    expect(bound.renderedSha).toBe(foldDigest(JSON.stringify(rendered)));
    expect(bound.renderedSha).not.toBe(bound.submittedSha);
    expect(hard).toEqual([]);
    expect(f.count()).toBe(1);
});
test("R3a cut before provisional watermark is a HARD divergence and is not bound", async () => {
    const f = fixture();
    const pending = await f.supply(18);
    const hard: string[] = [];
    const state = await f.owner.observe({
        sessionID: "s",
        cutSeq: 17,
        summary: pending.submitted,
        rendered: f.rendered(pending.submitted),
        onHard: (reason) => hard.push(reason),
    });
    expect(hard).toEqual(["host_cut_before_watermark"]);
    expect(state.cutSeq).toBeUndefined();
    expect(state.rendered).toBeUndefined();
});
test("I8 mutated host render forces one HARD and never replaces the pinned identity", async () => {
    const f = fixture();
    const pending = await f.supply(12, 20);
    const original = f.rendered(pending.submitted);
    const hard: string[] = [];
    const observe = (summary: string) =>
        f.owner.observe({
            sessionID: "s",
            cutSeq: 20,
            summary,
            rendered: f.rendered(summary),
            onHard: (reason) => hard.push(reason),
        });
    await observe(pending.submitted);
    await observe("mutated");
    const state = await observe("mutated");
    expect(hard).toEqual(["host_rerender"]);
    expect(state.rendered).toEqual(original);
    expect(state.submitted).toBe(pending.submitted);
});
test("R3 local same-cut replay and later-cut fresh materialization", async () => {
    const f = fixture();
    const first = await f.supply(12, 20);
    expect((await f.supply(12, 20)).submittedSha).toBe(first.submittedSha);
    expect(f.count()).toBe(1);
    expect((await f.supply(12, 30)).submittedSha).not.toBe(first.submittedSha);
    expect(f.count()).toBe(2);
});
