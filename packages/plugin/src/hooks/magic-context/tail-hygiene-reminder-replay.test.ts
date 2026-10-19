import { expect, test } from "bun:test";
import {
    getChannel1NudgeState,
    getLastNudgeUndropped,
    setChannel2NudgeState,
} from "../../features/magic-context/storage-meta-persisted";
import { updateSessionMeta } from "../../features/magic-context/storage-meta-session";
import { insertTag } from "../../features/magic-context/storage-tags";
import { tailRefreshFixture } from "./__fixtures__/tail-hygiene-refresh";
import { maybeDeliverChannel2 } from "./channel2-delivery";
import { decideChannel1, reclaimableToolOutputCount } from "./ctx-reduce-nudge";
import { currentReclaimableToolOutputCount } from "./tail-hygiene-output-count";

for (const opencode2 of [false, true]) {
    test(`OpenCode ${opencode2 ? 2 : 1} first delivery counts current outputs and replay keeps its original bytes`, async () => {
        const fixture = tailRefreshFixture({ id: `count-replay-${opencode2}`, opencode2 });
        try {
            await fixture.serve();
            await fixture.reduce();
            await fixture.serve();
            fixture.append();
            await fixture.serve();
            expect(reclaimableToolOutputCount(fixture.state().baselineParts)).toBe(1);
            expect(currentReclaimableToolOutputCount(fixture.state())).toBe(2);
            const first = await fixture.toolResult();
            expect(first).toContain("Still unstamped: 2 spent tool outputs");
            const savedId = `saved-${opencode2}`;
            const savedPart = {
                type: "tool",
                callID: savedId,
                tool: "bash",
                state: {
                    status: "completed",
                    input: {},
                    output: first,
                    time: { start: 1, end: 2 },
                },
            };
            fixture.messages.push({ info: { id: savedId, role: "assistant" }, parts: [savedPart] });
            fixture.metadata.diagnostics = "different UI metadata";
            const owner = `third-${opencode2}`;
            fixture.messages.push({
                info: { id: owner, role: "assistant" },
                parts: [
                    {
                        type: "tool",
                        callID: owner,
                        tool: "edit",
                        state: {
                            status: "completed",
                            input: {},
                            output: "data ".repeat(40_000),
                            time: { start: 1, end: 2 },
                        },
                    },
                ],
            });
            insertTag(
                fixture.db,
                fixture.sessionId,
                owner,
                "tool",
                200_000,
                3,
                0,
                "edit",
                2,
                owner,
            );
            fixture.messages.push(
                ...Array.from({ length: 5 }, (_, index) => ({
                    info: { id: `later-${opencode2}-${index}`, role: "user" },
                    parts: [{ type: "text", text: "continue" }],
                })),
            );
            await fixture.serve();
            expect(currentReclaimableToolOutputCount(fixture.state())).toBe(3);
            const replayed = fixture.messages.find((message) => message.info.id === savedId)
                ?.parts[0] as typeof savedPart;
            expect(replayed.state.output).toBe(first);
            const state = fixture.state();
            const grace = getChannel1NudgeState(fixture.db, fixture.sessionId);
            const eligible = decideChannel1({
                ...state,
                lastNudgeUndropped: getLastNudgeUndropped(fixture.db, fixture.sessionId),
                lastNudgeLevel: grace.level,
                lastFireOrdinal: grace.ordinal,
                currentRealUserTurnCount: state.realUserTurnCount,
                hasRecentReduce: state.reducedSinceRefresh,
                postReduceGracePending: grace.postReduceGracePending,
                postReduceGraceBaselineU: grace.postReduceGraceBaselineU,
                postReduceGracePreLevel: grace.postReduceGracePreLevel,
            });
            expect(eligible.fire).toBe(true);
            const beforeRow = fixture.db
                .prepare(
                    "SELECT last_nudge_undropped, last_nudge_level FROM session_meta WHERE session_id=?",
                )
                .get(fixture.sessionId);
            expect(await fixture.toolResult(first)).toBe(first);
            expect(
                fixture.db
                    .prepare(
                        "SELECT last_nudge_undropped, last_nudge_level FROM session_meta WHERE session_id=?",
                    )
                    .get(fixture.sessionId),
            ).toEqual(beforeRow);
            expect(await fixture.toolResult()).toContain("3 spent tool outputs");
        } finally {
            fixture.db.close();
        }
    });
}

test("Channel 2 first delivery uses the current count and a delivered intent cannot rewrite it", async () => {
    const fixture = tailRefreshFixture({ id: "ceiling-current-count" });
    try {
        await fixture.serve();
        fixture.append();
        await fixture.serve();
        expect(currentReclaimableToolOutputCount(fixture.state())).toBe(2);
        const sent: string[] = [];
        const client = {
            session: {
                promptAsync: async (input: unknown) => {
                    sent.push(JSON.stringify(input));
                    return {};
                },
                messages: async () => ({ data: [] }),
            },
        } as unknown as NonNullable<Parameters<typeof maybeDeliverChannel2>[1]["client"]>;
        setChannel2NudgeState(fixture.db, fixture.sessionId, "pending");
        updateSessionMeta(fixture.db, fixture.sessionId, { isSubagent: false });
        expect(
            await maybeDeliverChannel2(fixture.sessionId, {
                db: fixture.db,
                client,
                baseline: fixture.state(),
            }),
        ).toBe(true);
        expect(sent[0]).toContain("2 spent tool outputs");
        const first = sent[0];
        fixture.metadata.diagnostics = "UI changes after first delivery";
        await fixture.serve();
        expect(
            await maybeDeliverChannel2(fixture.sessionId, {
                db: fixture.db,
                client,
                baseline: fixture.state(),
            }),
        ).toBe(false);
        expect(sent).toEqual([first]);
    } finally {
        fixture.db.close();
    }
});
