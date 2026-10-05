import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Relay } from "./relay";

const cleanups: (() => void)[] = [];
afterEach(() => {
    while (cleanups.length) cleanups.pop()!();
});

// A fake model server that streams one SSE chunk every 50 ms, `chunks` times or
// until its client goes away.
function slowUpstream(chunks = Number.POSITIVE_INFINITY) {
    const seen = { requests: 0, aborted: false, body: undefined as any };
    const server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch: async (req) => {
            seen.requests++;
            seen.body = await req.json();
            req.signal.addEventListener("abort", () => {
                seen.aborted = true;
            });
            let timer: ReturnType<typeof setInterval>;
            let sent = 0;
            const stream = new ReadableStream({
                start(controller) {
                    timer = setInterval(() => {
                        try {
                            if (sent++ >= chunks) {
                                clearInterval(timer);
                                controller.close();
                                return;
                            }
                            controller.enqueue(
                                new TextEncoder().encode(`data: ${JSON.stringify({ choices: [{ delta: { content: "x" } }] })}\n\n`),
                            );
                        } catch {
                            clearInterval(timer);
                        }
                    }, 50);
                },
                cancel() {
                    clearInterval(timer);
                    seen.aborted = true;
                },
            });
            return new Response(stream, { headers: { "content-type": "text/event-stream" } });
        },
    });
    cleanups.push(() => server.stop(true));
    return { url: `http://127.0.0.1:${server.port}/v1`, seen };
}

function relayFor(upstream: string, arm: "bracket" | "neutral" = "bracket") {
    const root = mkdtempSync(join(tmpdir(), "priming-relay-"));
    mkdirSync(join(root, "bodies"));
    const relay = new Relay({ root, arm, upstream, apiKey: "test-key", model: "m", maxTokens: 100, thinking: false, currentTurn: () => 7, priorCalls: 40 });
    relay.start();
    cleanups.push(() => {
        relay.stop();
        rmSync(root, { recursive: true, force: true });
    });
    return { relay, root };
}

const request = {
    model: "m",
    max_tokens: 5000,
    tools: [{ type: "function", function: { name: "ctx_reduce", description: "d" } }],
    messages: [{ role: "tool", tool_call_id: "a", content: "[dropped §3§]" }],
};

describe("Relay", () => {
    it("applies the arm's wording, the token cap and the thinking switch to the forwarded request", async () => {
        const upstream = slowUpstream(2);
        const { relay } = relayFor(upstream.url, "neutral");
        const response = await fetch(`${relay.url}/chat/completions`, { method: "POST", body: JSON.stringify(request) });
        expect(await response.text()).toContain('"content":"x"');
        await relay.settle(2000);
        expect(upstream.seen.body.messages[0].content).toBe("(removed: tag 3)");
        expect(upstream.seen.body.max_tokens).toBe(100);
        expect(upstream.seen.body.chat_template_kwargs).toEqual({ enable_thinking: false });
        expect(relay.calls[0]!.exposure.droppedToolResults).toBe(1);
    });

    it("refuses a non-loopback upstream", () => {
        expect(() => relayFor("https://api.example.com/v1")).toThrow("loopback");
    });

    it("aborts the upstream request when the caller disconnects mid-stream", async () => {
        const upstream = slowUpstream();
        const { relay, root } = relayFor(upstream.url);
        const response = await fetch(`${relay.url}/chat/completions`, { method: "POST", body: JSON.stringify(request) });
        const reader = response.body!.getReader();
        await reader.read();
        await reader.cancel();
        for (let i = 0; i < 40 && !upstream.seen.aborted; i++) await Bun.sleep(25);
        expect(upstream.seen.aborted).toBe(true);
        await relay.settle(2000);
        const call = JSON.parse(readFileSync(join(root, "calls.jsonl"), "utf8").trim());
        expect(call).toMatchObject({ index: 41, turn: 7, lane: "main", cancelledByClient: true });
    });
});
