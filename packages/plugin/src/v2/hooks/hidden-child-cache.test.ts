import { expect, test } from "bun:test";
import { HiddenChildHook } from "./hidden-child";
import type { SessionContext } from "./types";

const body =
    '{ "model":"claude-test", "max_tokens":1e3,"system":[{"type":"text","text":"stable","cache_control":{"type":"ephemeral"}}],"messages":[{"role":"user","content":[{"type":"text","text":"variable","cache_control":{"type":"ephemeral"}}]}] }';
const expected = body.replace(',"cache_control":{"type":"ephemeral"}}]}]', "}]}]");
function request(sessionID: string, text = body) {
    return {
        sessionID,
        kind: "primary",
        request: new Request("https://mock.invalid/v1/messages", { method: "POST", body: text }),
    };
}
function registered(cacheTail: "skip" | "write" = "skip") {
    const hook = new HiddenChildHook();
    hook.registerChild("child", "historian");
    hook.registerAttempt("marker", {
        childSessionId: "child",
        shaped: false,
        identity: {
            agent: "historian",
            kind: "historian",
            system: "stable",
            title: "test",
            directory: "/tmp",
            timeoutMs: 1000,
        },
        request: {
            path: { id: "child" },
            cacheTail,
            body: { parts: [{ type: "text", text: "variable" }] },
        },
    });
    hook.apply({
        sessionID: "child",
        agent: "historian",
        model: { providerID: "anthropic", id: "claude-test" },
        system: [],
        messages: [{ role: "user", content: [{ type: "text", text: "marker" }] }],
        options: {},
        tools: {},
    } as SessionContext);
    return hook;
}

test("registered historian first wire request removes only tail bytes; host retry retains them", async () => {
    const hook = registered();
    const first = request("child");
    await hook.cacheRequest(first);
    expect(await first.request.text()).toBe(expected);
    const retry = request("child");
    await hook.cacheRequest(retry);
    expect(await retry.request.text()).toBe(body);
});

test("main-session request is byte-identical even while a historian is active", async () => {
    const hook = registered();
    const main = request("main");
    const originalRequest = main.request;
    await hook.cacheRequest(main);
    expect(main.request).toBe(originalRequest);
    expect(await main.request.text()).toBe(body);
});

test("explicit conversational reuse and outer retries retain the original tail", async () => {
    const hook = registered("write");
    const turn = request("child");
    await hook.cacheRequest(turn);
    expect(await turn.request.text()).toBe(body);
});

test("malformed bodies fail open, log once and never consume the original body", async () => {
    const hook = registered();
    const broken = request("child", "{bad");
    const original = broken.request;
    await hook.cacheRequest(broken);
    expect(broken.request).toBe(original);
    expect(await broken.request.text()).toBe("{bad");
});
