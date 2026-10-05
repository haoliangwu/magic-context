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
    /** A run holds its lineage until a terminal unit is delivered. Broca queues any
     *  further send on a busy lineage instead of starting a second run. */
    live: boolean;
    /** Paused runs stay live: the lineage is still occupied by them. */
    pauses: boolean;
}

const routeSessions = new Map<number, string>();
const runs = new Map<string, RunRecord>();
const latestRunBySession = new Map<string, string>();
const queuedSubmissions = new Map<string, string>();
let nextRun = 1;
let nextSubmission = 1;

/** A prompt carrying this marker parks its run instead of finishing it, the way the
 *  real Broca parks a run whose provider credential needs attention. The run stays
 *  the lineage's live run, so anything sent to the same lineage afterwards queues. */
const PAUSE_MARKER = "hermetic-broca-pause-this-run";

function liveRunForSession(sessionId: string): RunRecord | undefined {
    const runId = latestRunBySession.get(sessionId);
    const run = runId ? runs.get(runId) : undefined;
    return run?.live ? run : undefined;
}

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

const CLASSIFY_POOL_HEADER = "### Memory pool to classify";

function isClassifyPrompt(prompt: string): boolean {
    return prompt.includes(CLASSIFY_POOL_HEADER);
}

/** Ids the classify prompt lists in its pool. Anything before the pool header is the
 *  anchor block, whose ids must NOT appear in the manifest. */
function classifyPoolIds(prompt: string): number[] {
    const pool = prompt.slice(prompt.indexOf(CLASSIFY_POOL_HEADER));
    return [...pool.matchAll(/^\[(\d+)\]\s/gm)].map((match) => Number(match[1]));
}

/** A well-formed classify manifest covering exactly the prompt's pool, with a spread of
 *  importances so a caller can tell a real classification from a constant. */
function deterministicClassifyManifest(prompt: string): string {
    const entries = [...new Set(classifyPoolIds(prompt))].map(
        (id, index) =>
            `<memory id="${id}" importance="${20 + ((index * 7) % 70)}" scope="project" shareable="true"/>`,
    );
    return `<classify>\n${entries.join("\n")}\n</classify>`;
}

function deterministicOutput(prompt: string): string {
    if (isClassifyPrompt(prompt)) return deterministicClassifyManifest(prompt);
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

// The operation set Broca actually publishes. `session.delete` is deliberately absent:
// the real module answers unknown_method for it, so a producer cannot purge a lineage.
const manifest = managementSurfaceManifest({
    moduleId: MODULE_ID,
    operations: [
        { name: "session.send", kind: "mutate" },
        { name: "session.subscribe", kind: "query" },
        { name: "session.retract", kind: "mutate" },
        { name: "run.status", kind: "query" },
        { name: "run.cancel", kind: "mutate" },
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
            // A lineage runs one episode at a time. A send that arrives while the lineage
            // still holds a live run is durably QUEUED and answered with a submission id
            // instead of a run id — the caller's prompt was accepted, not rejected.
            const busy = liveRunForSession(sessionId);
            if (busy) {
                const submissionId = `broca-submission-${nextSubmission++}`;
                queuedSubmissions.set(submissionId, sessionId);
                log(
                    `session.send queued submission_id=${submissionId} session=${sessionId} behind run_id=${busy.runId}`,
                );
                return jsonBytes({ result: { state: "pending", submission_id: submissionId } });
            }
            const runId = `broca-run-${nextRun++}`;
            const run: RunRecord = {
                runId,
                sessionId,
                output: deterministicOutput(prompt),
                live: true,
                pauses: prompt.includes(PAUSE_MARKER),
            };
            runs.set(runId, run);
            latestRunBySession.set(sessionId, runId);
            const truncationMarkers = (
                prompt.match(/tokens truncated by Magic Context to fit the historian window/g) ?? []
            ).length;
            log(
                `session.send run_id=${runId} session=${sessionId} system_bytes=${system.length} prompt_bytes=${prompt.length} truncation_markers=${truncationMarkers}`,
            );
            return jsonBytes({ result: { state: "active", run_id: runId } });
        }
        if (method === "session.retract") {
            const submissionId =
                typeof params.submission_id === "string" ? params.submission_id : "";
            const known = queuedSubmissions.delete(submissionId);
            log(`session.retract submission_id=${submissionId} known=${known}`);
            return jsonBytes({ result: known ? "retracted" : "not_pending" });
        }
        if (method === "session.subscribe") {
            const sessionId = requestSession(handle);
            const runId = latestRunBySession.get(sessionId);
            const run = runId ? runs.get(runId) : undefined;
            if (!run) throw new Error(`no historian run for session ${sessionId}`);
            log(`session.subscribe run_id=${run.runId} session=${sessionId}`);
            await ctx.emit(event(run, { type: "run_started" }));
            if (run.pauses) {
                // A paused run has not ended: it remains the lineage's live run, exactly
                // as it does when the real Broca parks a run awaiting attention.
                await ctx.emit(event(run, { type: "paused", reason: "hermetic pause" }));
                return;
            }
            await ctx.emit(event(run, {
                type: "assistant_message",
                message: { role: "assistant", content: [{ type: "text", text: run.output }] },
            }));
            await ctx.emit(event(run, { type: "run_finished" }));
            run.live = false;
            return;
        }
        if (method === "run.status") {
            const runId = typeof params.run_id === "string" ? params.run_id : "";
            const run = runs.get(runId);
            if (!run) return jsonBytes({ run_id: runId, state: "error", last_error: "unknown run" });
            return jsonBytes({ run_id: runId, state: run.live ? "active" : "completed" });
        }
        if (method === "run.cancel") {
            const runId = typeof params.run_id === "string" ? params.run_id : "";
            const run = runs.get(runId);
            if (run) run.live = false;
            log(`run.cancel run_id=${runId}`);
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
