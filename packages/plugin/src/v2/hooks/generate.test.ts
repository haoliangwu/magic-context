import { expect, spyOn, test } from "bun:test";
import * as logger from "../../shared/logger";
import { generateReplayAnchor, V2GenerateReplay } from "./generate";
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
    replay.capture(served, generateReplayAnchor(served.messages));
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
    replay.capture(input, { id: "missing", tail: [] });
    expect(replay.apply(input)).toBe(false);
    expect(JSON.stringify(input)).toBe(bytes);
    replay.capture(input, generateReplayAnchor(input.messages));
    input.model.id = "other";
    expect(replay.apply(input)).toBe(false);
    input.model.id = "m";
    replay.forget("s");
    expect(replay.apply(input)).toBe(false);
});

test("generate captures the final request with id-less tool tails without duplicating them", () => {
    const replay = new V2GenerateReplay();
    const first = draft();
    replay.capture(first, generateReplayAnchor(first.messages));
    const raw = draft();
    raw.messages.push(
        { id: "a", role: "assistant", content: [{ type: "tool-call", id: "call-1" }] },
        { role: "tool", content: [{ type: "tool-result", id: "call-1", result: "raw one" }] },
        { role: "tool", content: [{ type: "tool-result", id: "call-2", result: "raw two" }] },
    );
    const anchor = generateReplayAnchor(raw.messages);
    expect(anchor?.id).toBe("a");
    expect(anchor?.tail).toEqual(raw.messages.slice(2));
    const served = structuredClone(raw);
    served.system = [{ text: "final system" }];
    served.tools = { tool: { description: "final description", input: {} } };
    served.messages[0]!.content[0]!.text = "<session-history>final summary</session-history>";
    served.messages[2]!.content[0]!.result = "§1§ managed one";
    served.messages[3]!.content[0]!.result = "[dropped]";
    served.messages.push({
        role: "tool",
        content: [{ type: "tool-result", id: "mc", result: "managed synthetic" }],
    });
    replay.capture(served, anchor);
    const input = structuredClone(raw);
    const live = [
        { id: "final", role: "assistant", content: [{ type: "text", text: "answer" }] },
        { role: "user", content: [{ type: "text", text: "btw" }] },
    ];
    input.messages.push(...live);
    const next = structuredClone(input);
    expect(replay.apply(input)).toBe(true);
    expect(JSON.stringify(input.messages)).toBe(JSON.stringify([...served.messages, ...live]));
    expect(input.system).toEqual(served.system);
    expect(input.tools).toEqual(served.tools);
    input.messages[2]!.content[0]!.result = "caller mutation";
    anchor!.tail[0]!.content[0]!.result = "anchor mutation";
    expect(replay.apply(next)).toBe(true);
    expect(next.messages).toEqual([...served.messages, ...live]);
});

test("generate rejects a changed or missing id-less anchor tail without consuming live messages", () => {
    const replay = new V2GenerateReplay();
    const served = draft();
    replay.capture(served, {
        id: "u",
        tail: [{ role: "tool", content: [{ type: "tool-result", id: "call", result: "raw" }] }],
    });
    for (const tail of [
        [],
        [{ role: "tool", content: [{ type: "tool-result", id: "call", result: "changed" }] }],
        [{ role: "user", content: [{ type: "text", text: "btw" }] }],
    ]) {
        const input = draft();
        input.messages.push(...tail);
        const before = JSON.stringify(input);
        expect(replay.apply(input)).toBe(false);
        expect(JSON.stringify(input)).toBe(before);
    }
});

test("generate logs each capture and apply skip once", () => {
    const logging = spyOn(logger, "sessionLog").mockImplementation(() => {});
    logging.mockClear();
    try {
        const replay = new V2GenerateReplay();
        const input = draft();
        expect(replay.apply(input)).toBe(false);
        replay.capture(input, { id: "missing", tail: [] });
        expect(replay.apply(input)).toBe(false);
        replay.capture(input, { id: "u", tail: [] });
        input.model.id = "other";
        expect(replay.apply(input)).toBe(false);
        input.model.id = "m";
        input.agent = "other";
        expect(replay.apply(input)).toBe(false);
        input.agent = "a";
        replay.capture(input, { id: "u", tail: [{ role: "tool", content: [] }] });
        expect(replay.apply(input)).toBe(false);
        const idless = [{ role: "tool", content: [] }];
        expect(generateReplayAnchor(idless)).toBeUndefined();
        replay.capture(input, generateReplayAnchor(idless));
        expect(replay.apply(input)).toBe(false);
        expect(logging.mock.calls.map((call) => call.slice(0, 2))).toEqual([
            ["s", "generate replay apply skipped: no-prefix"],
            ["s", "generate replay apply skipped: anchor-not-found"],
            ["s", "generate replay apply skipped: model-mismatch"],
            ["s", "generate replay apply skipped: agent-mismatch"],
            ["s", "generate replay apply skipped: anchor-tail-mismatch"],
            ["s", "generate replay capture skipped: no-anchor"],
            ["s", "generate replay apply skipped: no-prefix"],
        ]);
    } finally {
        logging.mockRestore();
    }
});
