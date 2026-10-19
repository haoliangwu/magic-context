import { expect, spyOn, test } from "bun:test";
import { tailRefreshFixture } from "./__fixtures__/tail-hygiene-refresh";
import { decideChannel1 } from "./ctx-reduce-nudge";
import * as hygiene from "./tail-hygiene-walk";

for (const metadataChange of [true, false]) {
    test(
        metadataChange
            ? "metadata-only edits preserve the later production Channel 1 nudge"
            : "successful same-generation refresh after reduce permits regrowth without metadata edits",
        async () => {
            const fixture = tailRefreshFixture({ id: `refresh-after-reduce-${metadataChange}` });
            try {
                await fixture.serve();
                const originalU = fixture.state().baselineU + fixture.state().turnDeltaU;
                const generation = fixture.state().baselineGeneration;
                await fixture.reduce();
                await fixture.serve();
                expect(fixture.state().baselineGeneration).toBe(generation);
                expect(fixture.state().evaluable).toBe(true);
                expect(fixture.state().reducedSinceRefresh).toBe(false);
                expect(fixture.state().channel1PostReduceGrace?.baselineU).toBe(originalU);
                if (metadataChange) {
                    fixture.metadata.output.progress++;
                    await fixture.serve();
                    expect(fixture.state().baselineGeneration).toBe(generation);
                }
                fixture.append();
                await fixture.serve();
                const state = fixture.state();
                const grace = state.channel1PostReduceGrace;
                const decision = decideChannel1({
                    ...state,
                    lastNudgeUndropped: originalU,
                    lastNudgeLevel: "urgent",
                    currentRealUserTurnCount: state.realUserTurnCount,
                    lastFireOrdinal: 1,
                    hasRecentReduce: state.reducedSinceRefresh,
                    postReduceGracePending: grace?.pending,
                    postReduceGraceBaselineU: grace?.baselineU,
                    postReduceGracePreLevel: grace?.preReduceLevel,
                });
                expect(decision.fire).toBe(true);
                expect(decision.verdictReason).toBe("post-reduce-regrowth-reached");
                expect(await fixture.toolResult()).toContain("Still unstamped:");
            } finally {
                fixture.db.close();
            }
        },
    );
}

test("a failed post-reduce baseline refresh keeps the dirty latch", async () => {
    const fixture = tailRefreshFixture({ id: "failed-after-reduce" });
    try {
        await fixture.serve();
        await fixture.reduce();
        const refresh = spyOn(hygiene, "refreshTailHygieneBaseline").mockImplementationOnce(() => {
            throw new Error("synthetic refresh failure");
        });
        try {
            await fixture.serve();
            expect(fixture.state().reducedSinceRefresh).toBe(true);
            expect(fixture.state().evaluable).toBe(false);
            expect(fixture.state().generationInvalidated).toBe(true);
        } finally {
            refresh.mockRestore();
        }
    } finally {
        fixture.db.close();
    }
});
