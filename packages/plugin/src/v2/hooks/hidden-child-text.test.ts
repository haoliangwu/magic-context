import { describe, expect, it, test } from "bun:test";
import {
    HiddenAgentStepLimit,
    HiddenChildHook,
    hiddenAgentFor,
    newestUserText,
} from "./hidden-child";
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

test("documentation proposals share the read-only mapper carrier", () => {
    expect(
        hiddenAgentFor({
            agent: "dreamer-docs",
            kind: "dreamer-task",
            system: "docs",
            timeoutMs: 1000,
            title: "docs",
            directory: "/tmp",
        }),
    ).toBe("dreamer-memory-mapper");
});

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

    it("gives the Curate child only ctx_memory", () => {
        const hook = new HiddenChildHook();
        hook.registerAttempt("mc:hidden:curate", {
            childSessionId: "ses-child",
            identity: {
                parentSessionId: "ses-parent",
                directory: "/tmp",
                agent: "dreamer",
                kind: "dreamer-task",
                system: "sys",
                timeoutMs: 1000,
            },
            request: { body: { parts: [{ type: "text", text: "calibrated" }] } },
            shaped: false,
        });
        const candidate = draft({
            role: "user",
            content: [{ type: "text", text: "mc:hidden:curate" }],
        });
        candidate.sessionID = "ses-child";
        candidate.tools = {
            read: { description: "read", input: {} },
            ctx_memory: { description: "memory", input: {} },
            ctx_memory_list: { description: "list", input: {} },
        };

        expect(hook.apply(candidate)).toBe(true);
        expect(Object.keys(candidate.tools).sort()).toEqual(["ctx_memory"]);
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

it("keeps accumulated tool results on the second step and releases the session binding", () => {
    const hook = new HiddenChildHook();
    hook.registerAttempt("mc:hidden:loop", {
        childSessionId: "ses-child",
        identity: {
            directory: "/tmp",
            agent: "dreamer",
            kind: "dreamer-task",
            system: "sys",
            timeoutMs: 1000,
            title: "curate",
        },
        request: { body: { parts: [{ type: "text", text: "calibrated" }] } },
        shaped: false,
    });
    const first = {
        ...draft({ role: "user", content: [{ type: "text", text: "mc:hidden:loop" }] }),
        sessionID: "ses-child",
    };
    first.tools = { ctx_memory: { description: "memory", input: {} } };
    expect(hook.apply(first)).toBe(true);
    const result = {
        role: "tool",
        content: [
            { type: "tool-result", name: "ctx_memory", result: { type: "text", value: "proof" } },
        ],
    };
    const next = {
        ...first,
        messages: [
            { role: "user", content: [{ type: "text", text: "mc:hidden:loop" }] },
            { role: "assistant", content: [{ type: "tool-call", name: "ctx_memory" }] },
            result,
        ],
        tools: { ...first.tools, read: { description: "read", input: {} } },
    };
    expect(hook.apply(next)).toBe(true);
    expect(next.messages[0]?.content).toEqual([{ type: "text", text: "calibrated" }]);
    expect(next.messages.at(-1)).toBe(result);
    expect(Object.keys(next.tools)).toEqual(["ctx_memory"]);
    const foreign = {
        ...next,
        messages: [
            { role: "user", content: [{ type: "text", text: "another prompt" }] },
            ...next.messages.slice(1),
        ],
    };
    expect(() => hook.apply(foreign)).toThrow("hidden_prompt_unrecognized");
    hook.releaseAttempt("mc:hidden:loop");
    expect(() => hook.apply(next)).toThrow("hidden_prompt_unrecognized");
});

it("finalizes a mapper before its cap with its checked history and no further tools", () => {
    const hook = new HiddenChildHook();
    const states: unknown[] = [];
    const attempt = {
        childSessionId: "ses-child",
        identity: {
            directory: "/tmp",
            agent: "dreamer-memory-mapper",
            kind: "dreamer-task" as const,
            system: "sys",
            timeoutMs: 1000,
            metadata: { onBudgetUpdate: (state: unknown) => states.push(state) },
        },
        request: { body: { parts: [{ type: "text", text: "calibrated" }] } },
        shaped: false,
    };
    hook.registerAttempt("mc:hidden:mapper", attempt);
    let candidate = draft({ role: "user", content: [{ type: "text", text: "mc:hidden:mapper" }] });
    for (let step = 1; step <= 58; step++) {
        candidate = {
            ...draft({ role: "user", content: [{ type: "text", text: "mc:hidden:mapper" }] }),
            sessionID: "ses-child",
            tools: { read: { description: "read", input: {} } },
        };
        expect(hook.apply(candidate)).toBe(true);
        if (step < 58) expect(Object.keys(candidate.tools)).toEqual(["read"]);
    }
    expect(Object.keys(candidate.tools)).toEqual([]);
    expect(JSON.stringify(candidate.messages.at(-1))).toContain("no more tool calls");
    expect(states).toContainEqual(expect.objectContaining({ finalizeFired: true }));
});

it("refuses a tool loop that exceeds its task's step budget", () => {
    const hook = new HiddenChildHook();
    const attempt = {
        childSessionId: "ses-child",
        identity: {
            directory: "/tmp",
            agent: "dreamer-retrospective",
            kind: "dreamer-task" as const,
            system: "sys",
            timeoutMs: 1000,
            title: "retrospective",
        },
        request: { body: { parts: [{ type: "text", text: "calibrated" }] } },
        shaped: false,
    };
    hook.registerAttempt("mc:hidden:limit", attempt);
    for (let step = 1; step <= 40; step++) {
        const candidate = {
            ...draft({ role: "user", content: [{ type: "text", text: "mc:hidden:limit" }] }),
            sessionID: "ses-child",
        };
        expect(hook.apply(candidate)).toBe(true);
    }
    const over = {
        ...draft({ role: "user", content: [{ type: "text", text: "mc:hidden:limit" }] }),
        sessionID: "ses-child",
    };
    expect(() => hook.apply(over)).toThrow(HiddenAgentStepLimit);
    expect(attempt.stepLimit).toMatchObject({
        name: "HiddenAgentStepLimit",
        agent: "dreamer-retrospective",
        cap: 40,
    });
});

it("accepts the host's retry of a run on a reused child and sends only that run's rows", () => {
    // A historian child is reused across runs, so its history starts with an earlier run's
    // marker. When the host retries a provider error it runs the context hook again with that
    // whole history; the retry belongs to the current run and must not be refused.
    const hook = new HiddenChildHook();
    const identity = {
        parentSessionId: "ses-parent",
        directory: "/tmp",
        agent: "historian",
        kind: "historian" as const,
        system: "sys",
        timeoutMs: 1000,
    };
    hook.registerAttempt("mc:hidden:second", {
        childSessionId: "ses-child",
        identity,
        request: { body: { parts: [{ type: "text", text: "calibrated second" }] } },
        shaped: false,
    });
    const earlierRun = [
        { role: "user", content: [{ type: "text", text: "mc:hidden:first" }] },
        { role: "assistant", content: [{ type: "text", text: "first summary" }] },
    ] as SessionContext["messages"];
    const marker = {
        role: "user",
        content: [{ type: "text", text: "mc:hidden:second" }],
    } as SessionContext["messages"][number];
    const step = () => ({
        ...draft(marker),
        sessionID: "ses-child",
        messages: [...earlierRun, marker],
    });
    const first = step();
    expect(hook.apply(first)).toBe(true);
    const retry = step();
    expect(hook.apply(retry)).toBe(true);
    expect(retry.messages).toEqual([
        { role: "user", content: [{ type: "text", text: "calibrated second" }] },
    ]);
    // A history that never carried this run's marker is still refused.
    const foreign = { ...step(), messages: [...earlierRun] };
    expect(() => hook.apply(foreign)).toThrow("hidden_prompt_unrecognized");
});
