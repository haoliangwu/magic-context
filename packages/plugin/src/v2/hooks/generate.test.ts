import { expect, test } from "bun:test";
import { V2GenerateReplay } from "./generate";
import type { SessionContext } from "./types";

const draft = (): SessionContext => ({
    sessionID: "s",
    model: { providerID: "p", id: "m" },
    agent: "a",
    system: [{ text: "host" }],
    messages: [{ id: "u", role: "user", content: [{ type: "text", text: "question" }] }],
    tools: {},
    options: {},
});

test("generate reuses exact served bytes and pristine live tail without changing replay state", () => {
    const replay = new V2GenerateReplay();
    const served = draft();
    served.system = [{ text: "managed system" }];
    served.tools = { ctx_reduce: { description: "managed description", input: {} } };
    served.messages.unshift({
        id: "m0",
        role: "user",
        content: [{ type: "text", text: "<session-history>summary</session-history>" }],
    });
    served.messages[1]!.content.push({ type: "text", text: "[dropped]" });
    replay.capture(served, "u");
    const input = draft();
    input.messages.push(
        { id: "a", role: "assistant", content: [{ type: "text", text: "live" }] },
        { role: "user", content: [{ type: "text", text: "btw" }] },
    );
    const next = structuredClone(input);
    expect(replay.apply(input)).toBe(true);
    expect(input.messages).toEqual([...served.messages, ...next.messages.slice(1)]);
    expect(input.system).toEqual(served.system);
    expect(input.tools).toEqual(served.tools);
    const bytes = JSON.stringify(input);
    input.messages[0]!.content[0]!.text = "caller mutation";
    expect(replay.apply(next)).toBe(true);
    expect(JSON.stringify(next)).toBe(bytes);
    expect(served.messages[0]!.content[0]!.text).toBe("<session-history>summary</session-history>");
});

test("generate leaves host request unchanged without a compatible anchored prefix", () => {
    const replay = new V2GenerateReplay();
    const input = draft();
    const bytes = JSON.stringify(input);
    expect(replay.apply(input)).toBe(false);
    replay.capture(input, "missing");
    expect(replay.apply(input)).toBe(false);
    expect(JSON.stringify(input)).toBe(bytes);
    replay.capture(input, "u");
    input.model.id = "other";
    expect(replay.apply(input)).toBe(false);
    input.model.id = "m";
    replay.forget("s");
    expect(replay.apply(input)).toBe(false);
});
