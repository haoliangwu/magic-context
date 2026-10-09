/// <reference types="bun-types" />

import { describe, expect, it } from "bun:test";
import { CheckoutClaimRefusalError } from "../features/magic-context/checkout-claim";
import { createMessagesTransformHandler } from "./messages-transform";

type Handler = ReturnType<typeof createMessagesTransformHandler>;

function userTurn(sessionId: string) {
    return {
        messages: [
            {
                info: { id: "msg_1", role: "user", sessionID: sessionId, time: { created: 1 } },
                parts: [{ type: "text", text: "hello" }],
            },
        ],
    } as unknown as Parameters<Handler>[1];
}

const REFUSAL = new CheckoutClaimRefusalError({ agentId: "agent_7", holder: "bb22cc33", epoch: 9 });

/** A wrapper whose inner transform only records that it ran (where Magic Context writes). */
function wrapper(options: {
    refusal: CheckoutClaimRefusalError | null;
    compactionOff?: boolean;
    internalChildSessions?: Set<string>;
}) {
    const ran: string[] = [];
    const notices: Array<{ sessionId: string; message: string }> = [];
    const asked: string[] = [];
    const handler = createMessagesTransformHandler({
        magicContext: {
            "experimental.chat.messages.transform": async () => {
                ran.push("transform");
            },
        } as never,
        compactionOff: options.compactionOff,
        internalChildSessions: options.internalChildSessions,
        checkoutClaim: {
            gate: {
                refusal: async (sessionId: string, projectRoot: string) => {
                    asked.push(`${sessionId}@${projectRoot}`);
                    return options.refusal;
                },
            },
            projectRoot: "/work/project",
            onRefusal: async (sessionId, message) => {
                notices.push({ sessionId, message });
            },
        },
    });
    return { handler, ran, notices, asked };
}

describe("OpenCode messages transform: checkout claim", () => {
    it("refuses a held-elsewhere session before the inner transform runs, in every compaction mode, and tells the user", async () => {
        // Compaction-off passes a failed pass's input through; a claim refusal
        // must not be passed through like that.
        for (const compactionOff of [false, true]) {
            const { handler, ran, notices, asked } = wrapper({ refusal: REFUSAL, compactionOff });
            const error = await handler({}, userTurn("ses_moved")).then(
                () => null,
                (caught: unknown) => caught,
            );
            expect(error).toBe(REFUSAL);
            expect(ran).toEqual([]);
            expect(asked).toEqual(["ses_moved@/work/project"]);
            expect(notices).toEqual([{ sessionId: "ses_moved", message: REFUSAL.message }]);
        }
    });

    it("runs the transform for an admitted session", async () => {
        const { handler, ran, notices } = wrapper({ refusal: null });
        await handler({}, userTurn("ses_here"));
        expect(ran).toEqual(["transform"]);
        expect(notices).toEqual([]);
    });

    it("does not check Magic Context's own child sessions, which belong to no agent", async () => {
        const { handler, ran, asked } = wrapper({
            refusal: REFUSAL,
            internalChildSessions: new Set(["ses_historian"]),
        });
        await handler({}, userTurn("ses_historian"));
        expect(asked).toEqual([]);
        expect(ran).toEqual(["transform"]);
    });
});
