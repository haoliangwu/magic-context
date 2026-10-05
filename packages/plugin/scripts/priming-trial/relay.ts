import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { measureExposure, neutralizeRequest, type Exposure, type PlaceholderArm } from "./placeholder";

export type RelayCall = {
    index: number;
    turn: number;
    lane: "main" | "aux";
    arm: PlaceholderArm;
    startedAt: number;
    durationMs?: number;
    firstByteMs?: number;
    status?: number;
    messages: number;
    exposure: Exposure;
    systemHead?: string;
    text: string;
    reasoning: string;
    toolCalls: { name: string; arguments: string }[];
    finish?: string;
    usage?: Record<string, any>;
    timings?: Record<string, any>;
    error?: string;
    /** The caller disconnected before the reply finished; the upstream request was aborted. */
    cancelledByClient?: boolean;
};

export type RelayOptions = {
    root: string;
    arm: PlaceholderArm;
    upstream: string;
    apiKey: string;
    model: string;
    maxTokens: number;
    thinking: boolean;
    currentTurn: () => number;
    /** Calls already recorded by an earlier process for this run, so a resumed run keeps numbering. */
    priorCalls: number;
};

// Sits between OpenCode and the local model server. It applies the trial arm's
// placeholder wording to the finished request, records every call, and injects
// the server key itself so the key never appears in the throwaway OpenCode config.
// Requests are only ever forwarded to the configured loopback upstream.
export class Relay {
    readonly calls: RelayCall[] = [];
    private server?: ReturnType<typeof Bun.serve>;
    private pending = new Set<Promise<void>>();
    constructor(readonly options: RelayOptions) {
        const host = new URL(options.upstream).hostname;
        if (host !== "127.0.0.1" && host !== "localhost") throw new Error("Relay upstream must be a loopback address");
    }

    get url(): string {
        if (!this.server) throw new Error("Relay not started");
        return `http://127.0.0.1:${this.server.port}/v1`;
    }

    start(): void {
        // idleTimeout 0: a cache-missing prefill can sit silent for several minutes.
        this.server = Bun.serve({ hostname: "127.0.0.1", port: 0, idleTimeout: 0, fetch: (req) => this.handle(req) });
    }

    /** Waits for in-flight stream captures, but never longer than the given bound. */
    async settle(limitMs = 120_000): Promise<void> {
        const deadline = Date.now() + limitMs;
        while (this.pending.size && Date.now() < deadline)
            await Promise.race([Promise.all([...this.pending]), Bun.sleep(Math.max(0, deadline - Date.now()))]);
    }

    stop(): void {
        this.server?.stop(true);
    }

    private async handle(req: Request): Promise<Response> {
        const path = new URL(req.url).pathname;
        if (!path.endsWith("/chat/completions")) return new Response("not found", { status: 404 });
        const parsed = JSON.parse(await req.text());
        if (parsed.model !== this.options.model) return new Response("unexpected model", { status: 400 });
        const toolNames: string[] = (parsed.tools ?? []).map((tool: any) => tool.function?.name);
        const lane = toolNames.includes("ctx_reduce") ? "main" : "aux";
        const exposure = measureExposure(parsed);
        const body = this.options.arm === "neutral" ? neutralizeRequest(parsed) : parsed;
        delete body.max_completion_tokens;
        // The cap bounds a runaway reply at this server's speed. The historian writes
        // a whole compartment block in one reply, so its lane gets twice the room.
        const cap = lane === "aux" ? this.options.maxTokens * 2 : this.options.maxTokens;
        body.max_tokens = Math.min(body.max_tokens ?? cap, cap);
        if (!this.options.thinking) body.chat_template_kwargs = { ...(body.chat_template_kwargs ?? {}), enable_thinking: false };
        body.stream_options = { ...(body.stream_options ?? {}), include_usage: true };
        const call: RelayCall = {
            index: this.options.priorCalls + this.calls.length + 1,
            turn: this.options.currentTurn(),
            lane,
            arm: this.options.arm,
            startedAt: Date.now(),
            messages: body.messages?.length ?? 0,
            exposure,
            text: "",
            reasoning: "",
            toolCalls: [],
        };
        if (lane === "aux") {
            const system = body.messages?.find((message: any) => message.role === "system")?.content;
            call.systemHead = String(typeof system === "string" ? system : JSON.stringify(system ?? "")).slice(0, 160);
        }
        this.calls.push(call);
        const serialized = JSON.stringify(body);
        writeFileSync(join(this.options.root, "bodies", `${String(call.index).padStart(5, "0")}.json.gz`), Bun.gzipSync(serialized));
        const done = this.forward(call, serialized);
        return done;
    }

    private async forward(call: RelayCall, serialized: string): Promise<Response> {
        let response: Response;
        // A caller that gives up (OpenCode aborting a slow historian prompt) must stop
        // the server's generation too, as a direct connection would; otherwise the
        // abandoned reply keeps the single-slot server busy for minutes.
        const abort = new AbortController();
        try {
            // Bun's fetch gives up after five minutes by default, shorter than a
            // cache-missing historian prompt takes on this server.
            response = await fetch(`${this.options.upstream}/chat/completions`, {
                method: "POST",
                headers: { "content-type": "application/json", authorization: `Bearer ${this.options.apiKey}` },
                body: serialized,
                signal: abort.signal,
                timeout: false,
            } as RequestInit);
        } catch (error) {
            call.error = String((error as Error).message).slice(0, 300);
            this.write(call);
            return new Response(JSON.stringify({ error: { message: "upstream unreachable" } }), { status: 502 });
        }
        call.status = response.status;
        if (!response.ok || !response.body) {
            call.error = (await response.text().catch(() => "")).slice(0, 300);
            call.durationMs = Date.now() - call.startedAt;
            this.write(call);
            return new Response(JSON.stringify({ error: { message: `upstream HTTP ${response.status}` } }), {
                status: response.status,
                headers: { "content-type": "application/json" },
            });
        }
        const [forward, observe] = response.body.tee();
        const capture = this.observe(call, observe).finally(() => {
            this.write(call);
            this.pending.delete(capture);
        });
        this.pending.add(capture);
        const reader = forward.getReader();
        const downstream = new ReadableStream<Uint8Array>({
            async pull(controller) {
                const chunk = await reader.read();
                if (chunk.done) controller.close();
                else controller.enqueue(chunk.value);
            },
            cancel(reason) {
                call.cancelledByClient = true;
                abort.abort(reason);
            },
        });
        return new Response(downstream, {
            status: response.status,
            headers: { "content-type": response.headers.get("content-type") ?? "text/event-stream" },
        });
    }

    private async observe(call: RelayCall, stream: ReadableStream<Uint8Array>): Promise<void> {
        const reader = stream.getReader();
        const decoder = new TextDecoder();
        const tools = new Map<number, { name: string; arguments: string }>();
        let buffer = "";
        try {
            while (true) {
                const chunk = await reader.read();
                if (chunk.done) break;
                call.firstByteMs ??= Date.now() - call.startedAt;
                buffer += decoder.decode(chunk.value, { stream: true });
                let newline: number;
                while ((newline = buffer.indexOf("\n")) !== -1) {
                    const line = buffer.slice(0, newline).trim();
                    buffer = buffer.slice(newline + 1);
                    if (!line.startsWith("data:") || line.slice(5).trim() === "[DONE]") continue;
                    const event = JSON.parse(line.slice(5));
                    if (event.usage) call.usage = event.usage;
                    if (event.timings) call.timings = event.timings;
                    for (const choice of event.choices ?? []) {
                        if (choice.finish_reason) call.finish = choice.finish_reason;
                        const delta = choice.delta ?? {};
                        call.text += delta.content ?? "";
                        call.reasoning += delta.reasoning_content ?? delta.reasoning ?? "";
                        for (const tool of delta.tool_calls ?? []) {
                            const value = tools.get(tool.index) ?? { name: "", arguments: "" };
                            value.name += tool.function?.name ?? "";
                            value.arguments += tool.function?.arguments ?? "";
                            tools.set(tool.index, value);
                        }
                    }
                }
            }
        } catch (error) {
            call.error = `capture: ${String((error as Error).message).slice(0, 200)}`;
        }
        call.toolCalls = [...tools.values()];
        call.durationMs = Date.now() - call.startedAt;
    }

    private write(call: RelayCall): void {
        appendFileSync(join(this.options.root, "calls.jsonl"), `${JSON.stringify(call)}\n`);
    }
}
