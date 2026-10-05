import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, readFileSync, existsSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { forbiddenOpenPaths } from "./bootstrap";
import type { ModelCaller } from "./host-adapter";
import type { Variant } from "./engine";
import { MagicContextConfigSchema } from "../../src/config/schema/magic-context";

export type ProviderCall = {
    index: number; model: string; responseModel?: string; status?: number; messages: number; tools: number;
    text: string; reasoning: string; calls: Record<string, unknown>[]; servedDroppedTags: number[];
    thinking?: string; maxTokens?: number; reasoningTokens?: number | null;
    usage?: Record<string, any>; finish?: string; durationMs?: number; error?: string;
};

export function generationSettings(variant: Variant): { thinking: { type: string }; max_tokens: number } {
    return { thinking: { type: variant === "D" ? "enabled" : "disabled" }, max_tokens: variant === "D" ? 4096 : 512 };
}

export function sanitizeProviderError(message: string, authorization: string): string {
    const key = authorization.replace(/^Bearer\s+/i, "");
    let detail = message;
    if (authorization) detail = detail.replaceAll(authorization, "[REDACTED]");
    if (key) detail = detail.replaceAll(key, "[REDACTED]");
    return detail.replace(/Bearer\s+\S+|sk-[\w-]+/gi, "[REDACTED]").slice(0, 500);
}

// This relay forwards authorization but never records headers or credentials.
// It observes the provider stream directly, independently of experimental.text.complete.
export class DeepSeekCaller implements ModelCaller {
    readonly calls: ProviderCall[] = [];
    private server?: ReturnType<typeof Bun.serve>;
    private child?: ChildProcess;
    private client: any;
    session = "";
    requireDroppedTag?: number;
    private captureOffset = 0;
    readonly authCopy: string;
    readonly capture: string;
    private url = "";
    private pendingCaptures: Promise<void>[] = [];
    private constructor(readonly root: string, readonly liveHome: string) {
        this.authCopy = join(root, "data", "opencode", "auth.json");
        this.capture = join(root, "capture.jsonl");
    }
    static async create(root: string, liveHome: string, stagedAuth: string, hostBinary: string): Promise<DeepSeekCaller> {
        const caller = new DeepSeekCaller(root, liveHome);
        try { await caller.boot(stagedAuth, hostBinary); return caller; }
        catch (error) { await caller.close(); throw error; }
    }
    private async boot(stagedAuth: string, hostBinary: string): Promise<void> {
        if (execFileSync(hostBinary, ["--version"], { encoding: "utf8" }).trim() !== "1.18.30") throw new Error("Pinned host version mismatch");
        for (const dir of ["data/opencode", "config/opencode", "cache", "home", "work"]) mkdirSync(join(this.root, dir), { recursive: true });
        copyFileSync(stagedAuth, this.authCopy);
        chmodSync(this.authCopy, 0o600);
        if (existsSync(this.capture)) this.captureOffset = readFileSync(this.capture, "utf8").trim().split("\n").filter(Boolean).length;
        else writeFileSync(this.capture, "");
        writeFileSync(join(this.root, "control.json"), JSON.stringify({ variant: "A", head: false }));
        this.server = Bun.serve({ hostname: "127.0.0.1", port: 0, idleTimeout: 255, fetch: async req => {
            const body = await req.text();
            const parsed = JSON.parse(body);
            if (this.calls.length >= 400) throw new Error("Live trial provider-call budget exceeded");
            const variant = JSON.parse(readFileSync(join(this.root, "control.json"), "utf8")).variant;
            Object.assign(parsed, generationSettings(variant));
            const call: ProviderCall = { index: this.calls.length + 1, model: parsed.model,
                messages: parsed.messages?.length ?? 0, tools: parsed.tools?.length ?? 0,
                text: "", reasoning: "", calls: [], thinking: parsed.thinking.type, maxTokens: parsed.max_tokens, reasoningTokens: null,
                servedDroppedTags: [...new Set([...JSON.stringify((parsed.messages ?? []).filter((message: any) => message.role === "tool")).matchAll(/\[dropped §(\d+)§\]/g)].map(match => Number(match[1])))] };
            this.calls.push(call);
            if (this.requireDroppedTag !== undefined && !call.servedDroppedTags.includes(this.requireDroppedTag)) {
                call.status = 400;
                call.error = "Required dropped tool-result tag was absent; upstream model call prevented";
                return new Response(JSON.stringify({ error: { message: call.error, type: "trial_guard" } }), { status: 400, headers: { "content-type": "application/json" } });
            }
            if (parsed.model !== "deepseek-flash") throw new Error("Unexpected provider model");
            const headers = new Headers(req.headers);
            headers.delete("host"); headers.delete("content-length");
            const started = Date.now();
            const response = await fetch(`https://api.deepseek.com${new URL(req.url).pathname}`, { method: req.method, headers, body: JSON.stringify(parsed) });
            call.status = response.status;
            if (!response.ok || !response.body) {
                // Keep only a sanitized error message, never the request headers or raw error body.
                const remote = await response.json().catch(() => ({})) as any;
                const authorization = headers.get("authorization") ?? "";
                call.error = sanitizeProviderError(String(remote.error?.message ?? remote.message ?? ""), authorization);
                call.durationMs = Date.now() - started;
                return new Response(JSON.stringify({ error: { message: `DeepSeek HTTP ${response.status}`, type: "provider_error" } }), { status: response.status, headers: { "content-type": "application/json" } });
            }
            const [forward, observe] = response.body.tee();
            const capture = (async () => {
                let buffer = "";
                const decoder = new TextDecoder();
                const reader = observe.getReader();
                const toolCalls = new Map<number, any>();
                while (true) {
                    const chunk = await reader.read();
                    if (chunk.done) break;
                    buffer += decoder.decode(chunk.value, { stream: true });
                    let newline: number;
                    while ((newline = buffer.indexOf("\n")) !== -1) {
                        const line = buffer.slice(0, newline).trim(); buffer = buffer.slice(newline + 1);
                        if (!line.startsWith("data:") || line.slice(5).trim() === "[DONE]") continue;
                        const event = JSON.parse(line.slice(5));
                        if (event.model) call.responseModel = event.model;
                        if (event.usage) {
                            call.usage = event.usage;
                            call.reasoningTokens = event.usage.completion_tokens_details?.reasoning_tokens ?? event.usage.reasoning_tokens ?? null;
                        }
                        for (const choice of event.choices ?? []) {
                            if (choice.finish_reason) call.finish = choice.finish_reason;
                            const delta = choice.delta ?? {};
                            call.text += delta.content ?? "";
                            call.reasoning += delta.reasoning_content ?? "";
                            for (const tool of delta.tool_calls ?? []) {
                                const value = toolCalls.get(tool.index) ?? { id: "", name: "", arguments: "" };
                                if (tool.id) value.id = tool.id;
                                if (tool.function?.name) value.name += tool.function.name;
                                value.arguments += tool.function?.arguments ?? "";
                                toolCalls.set(tool.index, value);
                            }
                        }
                    }
                }
                call.calls = [...toolCalls.values()]; call.durationMs = Date.now() - started;
            })().catch(() => { call.finish = "capture-error"; });
            this.pendingCaptures.push(capture);
            return new Response(forward, { status: response.status, headers: { "content-type": response.headers.get("content-type") ?? "text/event-stream" } });
        } });
        const model = "deepseek/deepseek-flash";
        const config = {
            plugin: [`file://${resolve(import.meta.dir, "host-plugin.mjs")}`], enabled_providers: ["deepseek"], model, small_model: model,
            autoupdate: false, compaction: { auto: false, prune: false },
            provider: { deepseek: { npm: "@ai-sdk/openai-compatible", name: "DeepSeek trial", options: { baseURL: `http://127.0.0.1:${this.server.port}/v1` },
                models: { "deepseek-flash": { name: "DeepSeek v4.1 Flash", limit: { context: 128000, output: 4096 }, options: { thinking: { type: "disabled" } } } } } },
            agent: { trial: { mode: "primary", prompt: "Answer fixture questions concisely in one or two sentences. Follow explicit tool requests. Use only trial_read, trial_echo, trial_list, and ctx_reduce. Do not access any host files, credentials, or network tools.",
                tools: { "*": false, trial_read: true, trial_echo: true, trial_list: true, ctx_reduce: true } }, title: { disable: true } },
        };
        writeFileSync(join(this.root, "config", "opencode.json"), JSON.stringify(config));
        const magicContextConfig = {
            prompt: { preset: "full" }, transform_mode: "ts", dreamer: { disable: true }, historian: { disable: true },
            compressor: { enabled: false }, memory: { enabled: true, auto_promote: false, auto_search: { enabled: false } }, protected_tokens: 4000,
        };
        MagicContextConfigSchema.parse(magicContextConfig);
        writeFileSync(join(this.root, "config", "opencode", "magic-context.jsonc"), JSON.stringify(magicContextConfig));
        const env: Record<string, string> = {};
        for (const key of ["PATH", "LANG", "LC_ALL", "SHELL", "TERM"]) if (process.env[key]) env[key] = process.env[key]!;
        Object.assign(env, {
            HOME: join(this.root, "home"), TMPDIR: this.root, XDG_DATA_HOME: join(this.root, "data"), XDG_CACHE_HOME: join(this.root, "cache"), XDG_CONFIG_HOME: join(this.root, "config"), XDG_STATE_HOME: join(this.root, "data", "state"), XDG_RUNTIME_DIR: join(this.root, "data", "runtime"),
            OPENCODE_CONFIG_DIR: join(this.root, "config"), OPENCODE_DB: join(this.root, "data", "opencode", "opencode.db"),
            MAGIC_CONTEXT_STORAGE_DIR: join(this.root, "data", "cortexkit", "magic-context"), MAGIC_CONTEXT_LOG_PATH: join(this.root, "trial.log"),
            SELF_TAG_DIST: resolve(import.meta.dir, "../../dist/index.js"), SELF_TAG_CAPTURE: this.capture,
            SELF_TAG_CONTROL: join(this.root, "control.json"), OPENCODE_DISABLE_MODELS_FETCH: "true",
        });
        let stdout = "";
        this.child = spawn(hostBinary, ["serve", "--port", "0", "--hostname", "127.0.0.1"], { cwd: join(this.root, "work"), env, stdio: ["ignore", "pipe", "ignore"] });
        this.child.stdout!.on("data", data => { stdout += String(data); });
        for (let i = 0; i < 300; i++) {
            const match = stdout.match(/opencode server listening on (https?:\/\/[^\s]+)/);
            if (match) { this.url = match[1]; break; }
            if (this.child.exitCode !== null) throw new Error("OpenCode exited before readiness; stderr intentionally not captured");
            await Bun.sleep(100);
        }
        if (!this.url) throw new Error("OpenCode readiness timeout");
        const { createOpencodeClient } = await import("@opencode-ai/sdk");
        this.client = createOpencodeClient({ baseUrl: this.url });
    }
    async start(variant: Variant, scenario: string): Promise<string> {
        this.requireDroppedTag = undefined;
        writeFileSync(join(this.root, "control.json"), JSON.stringify({ variant, head: scenario === "literal-head" }));
        const response = await this.client.session.create({ body: { title: `self-tag ${variant} ${scenario}` } });
        if (!response.data?.id) throw new Error("Session creation failed");
        this.session = response.data.id;
        return this.session;
    }
    async send(prompt: string): Promise<unknown[]> {
        const response = await this.client.session.prompt({ path: { id: this.session }, body: { agent: "trial", model: { providerID: "deepseek", modelID: "deepseek-flash" }, parts: [{ type: "text", text: prompt }] } });
        await Promise.all(this.pendingCaptures);
        if (response.error || response.data?.info?.error) throw new Error("Host prompt failed; inspect sanitized provider status metadata");
        return this.events();
    }
    async flush(): Promise<unknown[]> {
        const before = this.calls.length;
        await this.client.session.prompt({ path: { id: this.session }, body: { agent: "trial", model: { providerID: "deepseek", modelID: "deepseek-flash" }, parts: [{ type: "text", text: "__SELF_TAG_FLUSH_ONLY__" }] } });
        if (this.calls.length !== before) throw new Error("Flush unexpectedly invoked the provider");
        return this.events();
    }
    events(): unknown[] {
        const lines = readFileSync(this.capture, "utf8").trim().split("\n").filter(Boolean);
        const events = lines.slice(this.captureOffset).map(line => JSON.parse(line)); this.captureOffset = lines.length;
        return events;
    }
    isolation(): { pid: number; dataDir: string; forbidden: string[]; lsof: string } {
        const pid = this.child?.pid;
        if (!pid) throw new Error("Missing host PID");
        const lsof = execFileSync("lsof", ["-Fn", "-p", String(pid)], { encoding: "utf8" });
        const forbidden = forbiddenOpenPaths(lsof, this.liveHome);
        if (forbidden.length) throw new Error("Live-store fence violated");
        return { pid, dataDir: join(this.root, "data"), forbidden, lsof };
    }
    async close(): Promise<void> {
        if (this.child && this.child.exitCode === null && this.child.signalCode === null) {
            const child = this.child;
            await new Promise<void>(resolve => {
                child.once("exit", () => resolve());
                child.kill("SIGTERM");
            });
        }
        this.server?.stop(true);
        rmSync(this.authCopy, { force: true });
    }
}
