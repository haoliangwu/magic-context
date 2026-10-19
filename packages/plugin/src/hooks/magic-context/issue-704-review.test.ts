import { expect, test } from "bun:test";
import { runMigrations } from "../../features/magic-context/migrations";
import { copySessionStateForClone } from "../../features/magic-context/storage-clone";
import { getOrCreateSessionMeta } from "../../features/magic-context/storage-meta-session";
import { adaptPayload } from "../../v2/hooks/payload";
import { tailRefreshFixture } from "./__fixtures__/tail-hygiene-refresh";
import { createToolExecuteAfterHook } from "./hook-handlers";
import { captureLkgSlot, replayLkg } from "./lkg-replay";
import { resetLkgSlotsForTest } from "./lkg-slot";
import { opencode1ToModelMessages } from "./opencode1-to-model-messages.fixture";
import { providerVisiblePartForOpenCode2 } from "./provider-visible-parts";
import { measureTailHygiene } from "./tail-hygiene-walk";
import { runPostTransformPhase } from "./transform-postprocess-phase";

const model = {
    providerID: "anthropic",
    id: "claude-sonnet-4-5",
    api: { npm: "@ai-sdk/anthropic", id: "claude-sonnet-4-5" },
};

function fixture() {
    const part = {
        type: "tool",
        callID: "review-call",
        tool: "bash",
        state: {
            status: "error",
            input: { command: "echo review" },
            error: "[dropped]",
            content: "display-only content",
            time: { start: 1, end: 2, compacted: 0 },
            metadata: { interrupted: true, output: "partial output" },
        },
    };
    const messages = [
        {
            info: {
                id: "review-owner",
                role: "assistant",
                providerID: model.providerID,
                modelID: model.id,
            },
            parts: [part],
        },
        { info: { id: "review-user", role: "user" }, parts: [{ type: "text", text: "continue" }] },
    ];
    const hash = (opencode2 = false) =>
        measureTailHygiene({ messages, tags: [], protectedTagNumbers: new Set(), opencode2 })
            .parts[0].contentHash;
    return { part, messages, hash };
}

test("issue 704 review OC1 ignores state.content that its serializer never reads", async () => {
    const f = fixture();
    const wire = JSON.stringify(await opencode1ToModelMessages(f.messages, model));
    const before = f.hash();
    f.part.state.content = "new UI data";
    expect(JSON.stringify(await opencode1ToModelMessages(f.messages, model))).toBe(wire);
    expect(f.hash()).toBe(before);
});

test("issue 704 review OC2 projection ignores OC1 compacted timestamps", () => {
    const f = fixture();
    const before = providerVisiblePartForOpenCode2(f.part);
    const wire = () => {
        const draft = {
            sessionID: "review",
            model: { providerID: "anthropic", id: model.id },
            messages: [
                { id: "review-owner", role: "assistant", content: [structuredClone(f.part)] },
            ],
        };
        adaptPayload(draft as never).commit();
        return JSON.stringify(draft.messages);
    };
    const beforeWire = wire();
    f.part.state.time.compacted = 1;
    expect(wire()).toBe(beforeWire);
    expect(providerVisiblePartForOpenCode2(f.part)).toEqual(before);
});

test("issue 704 review OC1 provider-visible interrupted output control", async () => {
    const f = fixture();
    const before = f.hash();
    const wire = JSON.stringify(await opencode1ToModelMessages(f.messages, model));
    f.part.state.metadata.output = "changed partial output";
    expect(JSON.stringify(await opencode1ToModelMessages(f.messages, model))).not.toBe(wire);
    expect(f.hash()).not.toBe(before);
});

test("issue 704 review OC2 provider-visible input control", () => {
    const f = fixture();
    const before = f.hash(true);
    f.part.state.input.command = "echo changed";
    expect(f.hash(true)).not.toBe(before);
});

for (const opencode2 of [false, true]) {
    test(`issue 704 review OC${opencode2 ? 2 : 1} delivered reminder survives restart fork recovery and signed hold`, async () => {
        const f = tailRefreshFixture({ id: `review-replay-${opencode2}`, opencode2 });
        try {
            runMigrations(f.db);
            await f.serve();
            await f.reduce();
            await f.serve();
            f.append();
            await f.serve();
            const delivered = await f.toolResult();
            expect(delivered).toContain("Still unstamped: 2 spent tool outputs");
            const saved = {
                info: { id: "saved-delivery", role: "assistant" },
                parts: [
                    {
                        type: "reasoning",
                        text: "signed thinking",
                        metadata: { anthropic: { signature: "review-signature" } },
                    },
                    {
                        type: "tool",
                        callID: "saved-call",
                        tool: "bash",
                        state: {
                            status: "completed",
                            input: {},
                            output: delivered,
                            time: { start: 1, end: 2 },
                        },
                    },
                ],
            };
            f.messages.push(saved, {
                info: { id: "tail-user", role: "user" },
                parts: [{ type: "text", text: "continue" }],
            });
            const position = f.messages.indexOf(saved);
            f.states.clear();
            await f.serve();
            expect(f.messages.indexOf(saved)).toBe(position);
            expect(saved.parts[1].state?.output).toBe(delivered);
            const restartedHook = createToolExecuteAfterHook({
                db: f.db,
                channel1StateBySession: f.states,
            });
            const replay = { output: delivered };
            await restartedHook({ sessionID: f.sessionId, tool: "bash" }, replay);
            expect(replay.output).toBe(delivered);

            const child = `${f.sessionId}-fork`;
            expect(
                copySessionStateForClone(f.db, f.sessionId, child, {
                    resolveBoundaryOrdinal: () => undefined,
                    includeTag: () => true,
                    includeMessageId: () => true,
                    selectPendingPiMarker: () => null,
                }).kind,
            ).toBe("migrated");
            await runPostTransformPhase({
                ...f.args,
                sessionId: child,
                sessionMeta: getOrCreateSessionMeta(f.db, child),
                activeThinkingPrefixHold: true,
                thinkingBindingRecoveryEnabledForModel: true,
            });
            expect(f.messages.indexOf(saved)).toBe(position);
            expect(saved.parts[1].state?.output).toBe(delivered);
            const childReplay = { output: delivered };
            await restartedHook({ sessionID: child, tool: "bash" }, childReplay);
            expect(childReplay.output).toBe(delivered);

            resetLkgSlotsForTest();
            expect(
                captureLkgSlot({
                    sessionId: child,
                    input: f.messages,
                    output: f.messages,
                    completeOutput: true,
                    modelKey: "review/model",
                    providerKey: "review",
                }),
            ).toBe(true);
            const recovered = replayLkg({
                sessionId: child,
                messages: structuredClone(f.messages),
                modelKey: "review/model",
                providerKey: "review",
            });
            expect(recovered.ok).toBe(true);
            if (!recovered.ok) throw new Error(recovered.reason);
            const recoveredSaved = recovered.messages[position];
            expect(recoveredSaved.info.id).toBe(saved.info.id);
            expect((recoveredSaved.parts[1] as (typeof saved.parts)[1]).state?.output).toBe(
                delivered,
            );
        } finally {
            resetLkgSlotsForTest();
            f.db.close();
        }
    });
}
