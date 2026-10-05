/**
 * Loopback recording proxy between the throwaway OpenCode host and a real provider.
 *
 * The host's provider `baseURL` points here. Each request is forwarded unchanged to the
 * route's upstream (headers included, so the key only ever lives in the host config), the
 * response is streamed back to the host as it arrives, and a copy is read for status, error
 * text and usage. Nothing about headers is recorded.
 *
 * The recorder enforces the scenario's call budget: once spent, it answers 429 locally
 * without contacting the provider, and the scenario aborts. After the first rejected call it
 * stops forwarding altogether, so the host's retries cost nothing.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CallRecord, ProviderRoute } from "./types";
import { readResponse, requestModel, requestShape, scrubError } from "./wire";

/** Hop-by-hop and length headers that must not be copied across the proxy. */
const DROP_REQUEST_HEADERS = ["host", "content-length", "accept-encoding", "connection"];
const DROP_RESPONSE_HEADERS = ["content-length", "content-encoding", "transfer-encoding", "connection"];

export interface Recorder {
    baseURL: string;
    calls: CallRecord[];
    setPhase(phase: string): void;
    /** Resolves once every response stream seen so far has been fully read. */
    settled(): Promise<void>;
    budgetExhausted(): boolean;
    /** Host requests answered locally after a rejection, never sent to the provider. */
    locallyRefused(): number;
    stop(): void;
}

export function startRecorder(
    route: ProviderRoute,
    budget: number,
    secrets: () => string[],
    bodiesDir?: string,
): Recorder {
    if (bodiesDir) mkdirSync(bodiesDir, { recursive: true, mode: 0o700 });
    const calls: CallRecord[] = [];
    const inflight = new Set<Promise<void>>();
    let phase = "start";
    let refused = false;
    let halted = false;
    let locallyRefused = 0;
    // The host keeps the upstream base path (`/v1`, `/api/v1`), so forwarding only swaps the origin.
    const upstreamOrigin = new URL(route.upstreamBase).origin;
    const basePath = new URL(route.upstreamBase).pathname.replace(/\/$/, "");

    const server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        idleTimeout: 255,
        async fetch(req) {
            const url = new URL(req.url);
            const text = await req.text();
            // After a rejection the host's own retry loop would resend the same request; the
            // answer is already known, so refuse locally with a non-retryable status.
            if (halted) {
                locallyRefused++;
                return Response.json(
                    { error: { message: "live harness stopped after a provider rejection", type: "harness_halt" } },
                    { status: 400 },
                );
            }
            const index = calls.length + 1;
            if (index > budget) {
                refused = true;
                return Response.json(
                    { error: { message: `live harness call budget of ${budget} spent`, type: "harness_budget" } },
                    { status: 429 },
                );
            }
            const record: CallRecord = {
                index,
                at: new Date().toISOString(),
                phase,
                path: url.pathname,
                model: requestModel(route.protocol, url.pathname, text),
                status: 0,
                accepted: false,
                error: null,
                usage: null,
                diagnostics: {},
                requestId: null,
                request: requestShape(route.protocol, text),
                durationMs: 0,
            };
            calls.push(record);
            if (bodiesDir) writeFileSync(join(bodiesDir, `${String(index).padStart(3, "0")}.json`), text);
            const headers = new Headers(req.headers);
            for (const name of DROP_REQUEST_HEADERS) headers.delete(name);
            const started = Date.now();
            let upstream: Response;
            try {
                upstream = await fetch(`${upstreamOrigin}${url.pathname}${url.search}`, {
                    method: req.method,
                    headers,
                    body: req.method === "GET" || req.method === "HEAD" ? undefined : text,
                    signal: AbortSignal.timeout(300_000),
                });
            } catch (error) {
                record.error = scrubError(`network: ${String(error)}`, secrets());
                record.durationMs = Date.now() - started;
                halted = true;
                return Response.json({ error: { message: "upstream unreachable" } }, { status: 502 });
            }
            record.status = upstream.status;
            record.requestId = upstream.headers.get("request-id") ?? upstream.headers.get("x-request-id");
            record.request.flags.bindingBeta = req.headers.get("anthropic-beta")?.includes("thinking-binding-controls-2026-08-01") ?? false;
            // Subscription plugins can sleep/retry for minutes on 429. Record the genuine
            // rejection, then return a non-retryable local error so a capped run stops promptly.
            if (!upstream.ok) {
                const raw = await upstream.text();
                const parsed = readResponse(route.protocol, raw);
                record.usage = parsed.usage;
                record.diagnostics = parsed.diagnostics;
                record.error = scrubError(raw, secrets());
                record.durationMs = Date.now() - started;
                halted = true;
                return Response.json({ type: "error", error: { type: "invalid_request_error",
                    message: `Live harness stopped after upstream HTTP ${upstream.status}; see recorded rejection` } }, { status: 400 });
            }
            const responseHeaders = new Headers(upstream.headers);
            for (const name of DROP_RESPONSE_HEADERS) responseHeaders.delete(name);
            if (!upstream.body) {
                record.accepted = upstream.ok;
                if (!record.accepted) halted = true;
                record.durationMs = Date.now() - started;
                return new Response(null, { status: upstream.status, headers: responseHeaders });
            }
            const [toHost, toRecord] = upstream.body.tee();
            const reading = (async () => {
                const bytes = await new Response(toRecord).arrayBuffer();
                // Bedrock streams binary event-stream frames. Latin-1 maps each byte to one
                // character, so the frame headers stay intact for the regex reader in wire.ts.
                const raw = Buffer.from(bytes).toString(route.protocol === "bedrock-converse" ? "latin1" : "utf8");
                const parsed = readResponse(route.protocol, raw);
                record.usage = parsed.usage;
                record.diagnostics = parsed.diagnostics;
                record.durationMs = Date.now() - started;
                if (!upstream.ok) record.error = scrubError(raw, secrets());
                else if (parsed.streamError) record.error = scrubError(parsed.streamError, secrets());
                record.accepted = upstream.ok && !parsed.streamError;
                if (!record.accepted) halted = true;
            })().catch((error) => {
                record.error = scrubError(`read: ${String(error)}`, secrets());
            });
            inflight.add(reading);
            void reading.finally(() => inflight.delete(reading));
            return new Response(toHost, { status: upstream.status, headers: responseHeaders });
        },
    });

    return {
        baseURL: `http://127.0.0.1:${server.port}${basePath}`,
        calls,
        setPhase(next) {
            phase = next;
        },
        async settled() {
            while (inflight.size > 0) await Promise.allSettled([...inflight]);
        },
        budgetExhausted: () => refused,
        locallyRefused: () => locallyRefused,
        stop: () => server.stop(true),
    };
}
