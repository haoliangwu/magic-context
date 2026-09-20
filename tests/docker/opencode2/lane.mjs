import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { OpenCode } from "/test/host/node_modules/@opencode/client/dist/promise/client.js";
import { awaitPluginActivation } from "/test/plugin-activation.ts";

const roots = ["HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME"];
for (const key of roots) {
    const value = process.env[key];
    if (!value || !value.startsWith("/test/hermetic/")) {
        throw new Error(`${key} must point inside /test/hermetic before OpenCode starts`);
    }
    mkdirSync(value, { recursive: true });
}
if (process.env.OPENCODE_DB !== "opencode2.db") throw new Error("OPENCODE_DB must be opencode2.db");
if (!process.env.MC_PLUGIN_SPEC) throw new Error("MC_PLUGIN_SPEC is required");

const requests = [];
let pressureNext = false;
const mock = Bun.serve({
    hostname: "127.0.0.1",
    port: 4010,
    async fetch(request) {
        const url = new URL(request.url);
        if (request.method === "GET" && url.pathname === "/v1/models") {
            return Response.json({ object: "list", data: [{ id: "mock-model", object: "model" }] });
        }
        if (request.method !== "POST" || url.pathname !== "/v1/chat/completions") {
            return Response.json({ error: { message: `unexpected mock route ${request.method} ${url.pathname}` } }, { status: 404 });
        }
        const body = await request.json();
        requests.push(body);
        const serialized = JSON.stringify(body);
        const pressure = serialized.includes("Trigger next-turn pressure");
        pressureNext ||= pressure;
        const inputTokens = pressure ? 15_000 : 100;
        const id = `chatcmpl-${requests.length}`;
        const model = typeof body.model === "string" ? body.model : "mock-model";
        const encoder = new TextEncoder();
        const stream = new ReadableStream({
            start(controller) {
                const send = (payload) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
                send({ id, object: "chat.completion.chunk", created: 1, model, choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }] });
                send({ id, object: "chat.completion.chunk", created: 1, model, choices: [{ index: 0, delta: { content: pressureNext ? "pressure reply" : "fixture reply" }, finish_reason: null }] });
                send({ id, object: "chat.completion.chunk", created: 1, model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: inputTokens, completion_tokens: 10, total_tokens: inputTokens + 10 } });
                controller.enqueue(encoder.encode("data: [DONE]\n\n"));
                controller.close();
            },
        });
        pressureNext = false;
        return new Response(stream, { headers: { "content-type": "text/event-stream" } });
    },
});

const directory = process.cwd();
writeFileSync(
    join(directory, "opencode.json"),
    JSON.stringify({
        plugins: [process.env.MC_PLUGIN_SPEC],
        model: "mock/mock-model",
        compaction: { auto: true, buffer: 1024, keep: { tokens: 1024 } },
        providers: {
            mock: {
                package: "@opencode/ai/providers/openai-compatible",
                settings: { baseURL: "http://127.0.0.1:4010/v1", apiKey: "mock-key" },
                models: {
                    "mock-model": {
                        name: "Mock Model",
                        limit: { context: 16_000, output: 1024 },
                        compaction: { mode: "local" },
                    },
                },
            },
        },
    }),
);
const mcConfig = join(process.env.XDG_CONFIG_HOME, "cortexkit");
mkdirSync(mcConfig, { recursive: true });
writeFileSync(
    join(mcConfig, "magic-context.jsonc"),
    JSON.stringify({
        auto_update: false,
        embedding: { provider: "off" },
        memory: { enabled: false },
        historian: { disable: true },
        dreamer: { disable: true },
    }),
);

const child = spawn("opencode2", ["serve", "--hostname", "127.0.0.1", "--port", "0", "--print-logs"], {
    cwd: directory,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
});
let stdout = "";
let stderr = "";
child.stdout.on("data", (chunk) => (stdout += chunk));
child.stderr.on("data", (chunk) => (stderr += chunk));
const exited = new Promise((resolve) => child.once("close", resolve));

async function handoff() {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
        const match = stdout.match(/server listening on (https?:\/\/\S+)[\s\S]*?server password (\S+)/);
        if (match) return { url: match[1], password: match[2] };
        if (child.exitCode !== null) throw new Error(`opencode2 exited ${child.exitCode}\n${stdout}\n${stderr}`);
        await Bun.sleep(25);
    }
    throw new Error(`opencode2 handoff timed out\n${stdout}\n${stderr}`);
}

try {
    const ready = await handoff();
    const client = OpenCode.make({
        baseUrl: ready.url,
        headers: { authorization: `Basic ${btoa(`opencode:${ready.password}`)}` },
    });
    const session = await client.session.create({
        location: { directory },
        model: { providerID: "mock", id: "mock-model" },
    });
    await awaitPluginActivation(client, directory);
    const plugins = await client.plugin.list({ location: { directory } });
    const active = plugins.data.find((plugin) => plugin.id === "opencode-magic-context");
    if (active?.state.status !== "active") throw new Error(`plugin not active: ${JSON.stringify(plugins.data)}`);

    const turn = async (text) => {
        await client.session.prompt({ sessionID: session.id, text });
        await client.session.wait(
            { sessionID: session.id },
            { signal: AbortSignal.timeout(30_000) },
        );
    };
    for (const marker of ["LANE-ALPHA", "LANE-BETA", "LANE-GAMMA"]) {
        await turn(`${marker} ${"source history detail ".repeat(500)}`);
    }
    await turn("Trigger next-turn pressure");
    await turn("First post-fold round-trip");

    if (requests.length < 5) throw new Error(`expected at least five provider requests, saw ${requests.length}`);
    const wire = JSON.stringify(requests);
    if (!wire.includes("<session-history>") && !wire.includes("<conversation-checkpoint>")) {
        throw new Error("provider capture did not contain Magic Context's transformed head");
    }

    const hostDbPath = join(process.env.XDG_DATA_HOME, "opencode", process.env.OPENCODE_DB);
    const hostDb = new Database(hostDbPath, { readonly: true });
    const folds = hostDb
        .prepare("SELECT count(*) AS count FROM session_message WHERE session_id = ? AND type = 'compaction' AND json_extract(data, '$.status') = 'completed'")
        .get(session.id).count;
    hostDb.close();
    if (folds < 1) throw new Error(`expected a completed host fold, saw ${folds}`);

    const mcDbPath = join(process.env.XDG_DATA_HOME, "cortexkit", "magic-context", "context.db");
    const mcDb = new Database(mcDbPath, { readonly: true });
    const sessions = mcDb
        .prepare("SELECT count(*) AS count FROM session_meta WHERE session_id = ? AND harness = 'opencode2'")
        .get(session.id).count;
    mcDb.close();
    if (sessions !== 1) throw new Error(`expected one opencode2 session_meta row, saw ${sessions}`);

    writeFileSync("/test/session-id", `${session.id}\n`);
    writeFileSync("/test/provider-requests.json", `${JSON.stringify(requests, null, 2)}\n`);
    console.log(`PASS real session transformed requests=${requests.length} session=${session.id}`);
    console.log(`PASS completed host fold rows=${folds}`);
    console.log(`PASS hermetic Magic Context database ${mcDbPath}`);
} catch (error) {
    console.error(stdout, stderr, error);
    throw error;
} finally {
    child.kill("SIGTERM");
    await Promise.race([exited, Bun.sleep(2_000)]);
    if (child.exitCode === null) child.kill("SIGKILL");
    mock.stop(true);
}
