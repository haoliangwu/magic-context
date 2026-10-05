import { expect, it } from "bun:test";
import { startRecorder } from "./recorder";
import { claudeOAuth } from "./scenarios/anthropic";

it("records upstream 429 but stops subscription retries with a local non-retryable error", async () => {
    let upstreamCalls = 0;
    const upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => {
        upstreamCalls++;
        return Response.json({ error: { message: "fixture rate limit" } }, { status: 429, headers: { "request-id": "req_fixture" } });
    } });
    const recorder = startRecorder({ ...claudeOAuth, upstreamBase: `http://127.0.0.1:${upstream.port}/v1` }, 3, () => []);
    try {
        const call = () => fetch(`${recorder.baseURL}/messages`, { method: "POST", body: JSON.stringify({ model: "claude-opus-5-5", messages: [] }) });
        expect((await call()).status).toBe(400);
        expect((await call()).status).toBe(400);
        await recorder.settled();
        expect(upstreamCalls).toBe(1);
        expect(recorder.calls).toHaveLength(1);
        expect(recorder.calls[0]).toMatchObject({ status: 429, accepted: false, requestId: "req_fixture", usage: null, diagnostics: {} });
        expect(recorder.locallyRefused()).toBe(1);
    } finally { recorder.stop(); upstream.stop(true); }
});
