/**
 * Hermetic historian producer for Rust-mode e2e tests.
 *
 * The real module-side historian speaks to a Broca management surface rather
 * than the OpenCode model mock. Keeping this producer in test support makes
 * that boundary real while keeping every response deterministic and offline.
 */

import {
    managementSurfaceManifest,
    SubcProvider,
    type ProviderRequestContext,
    type RouteBindRequest,
    type RouteHandle,
} from "@cortexkit/subc-client";

const MODULE_ID = "broca";
const connectionFile = process.env.BROCA_CONNECTION_FILE;
if (!connectionFile) throw new Error("BROCA_CONNECTION_FILE is required");

interface ProducerRequest {
    method?: string;
    params?: Record<string, unknown>;
}

interface RunRecord {
    runId: string;
    sessionId: string;
    output: string;
}

const routeSessions = new Map<number, string>();
const runs = new Map<string, RunRecord>();
const latestRunBySession = new Map<string, string>();
let nextRun = 1;

function log(message: string): void {
    process.stdout.write(`[broca] ${message}\n`);
}

function jsonBytes(value: unknown): Uint8Array {
    return new TextEncoder().encode(JSON.stringify(value));
}

function requestFrom(body: Uint8Array): ProducerRequest {
    return JSON.parse(new TextDecoder().decode(body)) as ProducerRequest;
}

function requestSession(handle: RouteHandle): string {
    const sessionId = routeSessions.get(handle.channel);
    if (!sessionId) throw new Error(`route ${handle.channel} is not bound to a session`);
    return sessionId;
}

function ordinalRange(prompt: string): { start: number; end: number } {
    const startMarker = prompt.indexOf("<new_messages>");
    const endMarker = prompt.indexOf("</new_messages>");
    const rawChunk =
        startMarker >= 0
            ? prompt.slice(startMarker + "<new_messages>".length, endMarker > startMarker ? endMarker : undefined)
            : prompt;
    const ordinals = [...rawChunk.matchAll(/^\s*\[(\d+)(?:-(\d+))?\]/gm)].flatMap(
        (match) => [Number(match[1]), Number(match[2] ?? match[1])],
    );
    if (ordinals.length > 0) {
        return {
            start: Math.min(...ordinals),
            end: Math.max(...ordinals),
        };
    }
    const range = prompt.match(/Messages\s+(\d+)-(\d+):/i);
    if (range) return { start: Number(range[1]), end: Number(range[2]) };
    return { start: 1, end: 1 };
}

function deterministicTitle(prompt: string, start: number, end: number): string {
    const knownLabels: Array<[string, string]> = [
        ["cache-invariant", "cache-invariant chunk"],
        ["Long OpenCode e2e chunk", "Long OpenCode e2e chunk"],
        ["long-running OpenCode", "Long OpenCode e2e chunk"],
        ["OpenCode warm-up cache-stability", "Long OpenCode e2e chunk"],
        ["Rust fold e2e chunk", "Rust fold e2e chunk"],
        ["fold-under-pressure", "Rust fold e2e chunk"],
        ["Rust reduce e2e chunk", "Rust reduce e2e chunk"],
        ["ctx_reduce", "Rust reduce e2e chunk"],
    ];
    for (const [needle, title] of knownLabels) {
        if (prompt.includes(needle)) return title;
    }
    return `Hermetic Broca chunk ${start}-${end}`;
}

function deterministicOutput(prompt: string): string {
    const { start, end } = ordinalRange(prompt);
    const title = deterministicTitle(prompt, start, end);
    const tierOne = `<p1>${title}</p1>`;
    return `<output>\n<compartments>\n` +
        `<compartment start="${start}" end="${end}" title="${title}" importance="50" episode_type="feature">\n` +
        `${tierOne}\n` +
        `<p2>Deterministic historian coverage ${start}-${end}.</p2>\n` +
        `<p3>Published by the hermetic Broca producer.</p3>\n` +
        `<p4>Replay is stable for this chunk.</p4>\n` +
        `</compartment>\n</compartments>\n` +
        `<facts></facts>\n` +
        `<events></events>\n` +
        `<unprocessed_from>${end + 1}</unprocessed_from>\n` +
        `</output>`;
}

function event(run: RunRecord, unit: Record<string, unknown>): Uint8Array {
    return jsonBytes({ kind: "control", unit: { run_id: run.runId, ...unit } });
}

const manifest = managementSurfaceManifest({
    moduleId: MODULE_ID,
    operations: [
        { name: "session.send", kind: "mutate" },
        { name: "session.subscribe", kind: "query" },
        { name: "run.status", kind: "query" },
        { name: "run.cancel", kind: "mutate" },
        { name: "session.delete", kind: "mutate" },
    ],
});

const provider = await SubcProvider.connect({
    connectionFile,
    manifest,
    health: () => ({ status: "ok", detail: "deterministic hermetic historian producer" }),
    onBind: (request: RouteBindRequest) => {
        if (request.target.kind !== "management_surface" || request.target.module_id !== MODULE_ID) {
            return { accept: false, code: "wrong_target", message: "Broca only serves its management surface" };
        }
        if (!request.identity.session) {
            return { accept: false, code: "missing_session", message: "Broca requires a session identity" };
        }
        routeSessions.set(request.handle.channel, request.identity.session);
        return true;
    },
    onBound: (handle: RouteHandle) => {
        log(`route_bound channel=${handle.channel}`);
    },
    onRouteGone: (handle: RouteHandle) => {
        routeSessions.delete(handle.channel);
        log(`route_gone channel=${handle.channel}`);
    },
    handler: async (handle: RouteHandle, body: Uint8Array, ctx: ProviderRequestContext) => {
        const request = requestFrom(body);
        const params = request.params ?? {};
        const method = request.method;
        if (method === "session.send") {
            const sessionId = requestSession(handle);
            const system = typeof params.system === "string" ? params.system : "";
            const prompt = typeof params.prompt === "string" ? params.prompt : "";
            if (!system || !prompt) throw new Error("session.send requires calibrated system and prompt fields");
            const runId = `broca-run-${nextRun++}`;
            const run: RunRecord = { runId, sessionId, output: deterministicOutput(prompt) };
            runs.set(runId, run);
            latestRunBySession.set(sessionId, runId);
            const truncationMarkers = (
                prompt.match(/tokens truncated by Magic Context to fit the historian window/g) ?? []
            ).length;
            log(
                `session.send run_id=${runId} session=${sessionId} system_bytes=${system.length} prompt_bytes=${prompt.length} truncation_markers=${truncationMarkers}`,
            );
            return jsonBytes({ run_id: runId });
        }
        if (method === "session.subscribe") {
            const sessionId = requestSession(handle);
            const runId = latestRunBySession.get(sessionId);
            const run = runId ? runs.get(runId) : undefined;
            if (!run) throw new Error(`no historian run for session ${sessionId}`);
            log(`session.subscribe run_id=${run.runId} session=${sessionId}`);
            await ctx.emit(event(run, { type: "run_started" }));
            await ctx.emit(event(run, {
                type: "assistant_message",
                message: { role: "assistant", content: [{ type: "text", text: run.output }] },
            }));
            await ctx.emit(event(run, { type: "run_finished" }));
            return;
        }
        if (method === "run.status") {
            const runId = typeof params.run_id === "string" ? params.run_id : "";
            if (!runs.has(runId)) return jsonBytes({ run_id: runId, state: "error", last_error: "unknown run" });
            return jsonBytes({ run_id: runId, state: "completed" });
        }
        if (method === "run.cancel") {
            const runId = typeof params.run_id === "string" ? params.run_id : "";
            log(`run.cancel run_id=${runId}`);
            return jsonBytes({ ok: true });
        }
        if (method === "session.delete") {
            const sessionId = typeof params.session_id === "string" ? params.session_id : requestSession(handle);
            for (const [runId, run] of runs) if (run.sessionId === sessionId) runs.delete(runId);
            latestRunBySession.delete(sessionId);
            return jsonBytes({ ok: true });
        }
        throw new Error(`unsupported Broca method ${method ?? "<missing>"}`);
    },
});

log(`ready module_id=${MODULE_ID}`);

const keepAlive = setInterval(() => undefined, 60_000);
const close = async (): Promise<void> => {
    clearInterval(keepAlive);
    await provider.close();
    process.exit(0);
};
process.once("SIGTERM", () => void close());
process.once("SIGINT", () => void close());
await new Promise<void>(() => undefined);
