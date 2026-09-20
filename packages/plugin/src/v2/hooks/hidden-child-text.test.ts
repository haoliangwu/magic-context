import { describe, expect, it } from "bun:test";
import { HiddenChildHook, newestUserText } from "./hidden-child";
import type { SessionContext } from "./types";

function draft(message: SessionContext["messages"][number]): SessionContext {
    return {
        sessionID: "ses-hidden",
        model: { providerID: "openai", id: "mock-model" },
        agent: "historian",
        messages: [message],
        system: [],
        tools: {},
        options: {},
    };
}

describe("newestUserText", () => {
    it("reads a single text part", () => {
        expect(
            newestUserText(
                draft({
                    role: "user",
                    content: [{ type: "text", text: "mc:hidden:marker" }],
                }),
            ),
        ).toBe("mc:hidden:marker");
    });

    it("reads a string body and input_text parts", () => {
        expect(
            newestUserText(
                draft({
                    role: "user",
                    content: "mc:hidden:string",
                } as SessionContext["messages"][number]),
            ),
        ).toBe("mc:hidden:string");
        expect(
            newestUserText(
                draft({
                    role: "user",
                    content: [{ type: "input_text", text: "mc:hidden:input" }, { type: "media" }],
                }),
            ),
        ).toBe("mc:hidden:input");
    });

    it("matches an attempt after v2 ordinal prefixes", () => {
        const hook = new HiddenChildHook();
        hook.registerChild("ses-child");
        hook.registerAttempt("mc:hidden:marker", {
            childSessionId: "ses-child",
            identity: {
                parentSessionId: "ses-parent",
                directory: "/tmp",
                agent: "historian",
                kind: "historian",
                system: "sys",
                timeoutMs: 1000,
            },
            request: { body: { parts: [{ type: "text", text: "calibrated" }] } },
            shaped: false,
        });
        const shaped = hook.apply({
            ...draft({
                role: "user",
                content: [{ type: "text", text: "§1§ §22§ mc:hidden:marker" }],
            }),
            sessionID: "ses-child",
        });
        expect(shaped).toBe(true);
    });
});
