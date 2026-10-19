import { join } from "node:path";
import { appendFileSync } from "node:fs";
import plugin from "../../../plugin/src/index";
import { tool } from "../../../plugin/node_modules/@opencode-ai/plugin/dist/index.js";
import { openDatabase } from "../../../plugin/src/features/magic-context/storage";
import { acquireCompartmentLease, releaseCompartmentLease } from "../../../plugin/src/features/magic-context/compartment-lease";
import { resolveWrapupProtectedTailBoundary } from "../../../plugin/src/hooks/magic-context/protected-tail-boundary";
import { setRawMessageProvider } from "../../../plugin/src/hooks/magic-context/read-session-chunk";
import { runCompartmentAgent } from "../../../plugin/src/hooks/magic-context/compartment-runner-incremental";
import { getActiveCompartmentRun } from "../../../plugin/src/hooks/magic-context/compartment-runner";

async function publicationReady(sessionId: string) {
    const active = getActiveCompartmentRun(sessionId);
    if (!active) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        await Promise.race([active.promise, new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => reject(new Error("background historian did not release its publication lease")), 15000);
        })]);
    } finally { clearTimeout(timer); }
}

function phase(sessionId: string, phase: string) {
    const trace = process.env.MC_S3_PHASE_TRACE;
    if (!trace) throw new Error("missing isolated publication trace");
    appendFileSync(trace, `${JSON.stringify({ sessionId, phase })}\n`);
}

export default {
    ...plugin,
    async server(context: any) {
        const state = process.env.XDG_STATE_HOME ?? process.env.XDG_DATA_HOME;
        if (!state) throw new Error("marker observer requires an isolated XDG directory");
        process.env.MAGIC_CONTEXT_LOG_PATH = join(state, "marker.log");
        const hooks = await plugin.server(context);
        const sources = new Map<string, any[]>();
        return {
            ...hooks,
            "experimental.chat.messages.transform": async (input: any, output: any) => {
                const sessionID = output.messages.find((message: any) => message.info?.sessionID)?.info.sessionID;
                if (sessionID) {
                    const response = await context.client.session.messages({ path: { id: sessionID }, query: { directory: context.directory } });
                    const rows = (response.data ?? response).filter((message: any) => message.info.summary !== true)
                        .map((message: any, index: number) => ({ id: message.info.id, ordinal: index + 1, role: message.info.role, createdAt: message.info.time?.created, parts: message.parts }));
                    if (!sources.has(sessionID)) setRawMessageProvider(sessionID, { readMessages: () => sources.get(sessionID) ?? [] });
                    sources.set(sessionID, rows);
                }
                await hooks["experimental.chat.messages.transform"]?.(input, output);
            },
            tool: {
                ...hooks.tool,
                s3_direct_historian: tool({
                    description: "Run the real historian using either publication mode for the v1 control.", args: { deferred: tool.schema.boolean() },
                    async execute(args: { deferred: boolean }, execution: any) {
                        const db = openDatabase()!;
                        const sessionId = execution.sessionID;
                        // Wait for the background historian to finish, including lease cleanup,
                        // rather than checking once whether the SQLite lease row is absent.
                        await publicationReady(sessionId);
                        phase(sessionId, "ready");
                        const holder = "s3-direct-control";
                        if (!acquireCompartmentLease(db, sessionId, holder)) throw new Error("control lease unavailable");
                        try {
                            const boundary = resolveWrapupProtectedTailBoundary({ db, sessionId, mode: "manual-wrapup", contextLimit: 16000, executeThresholdPercentage: 65, usage: { percentage: 0, inputTokens: 100 }, usageSource: "live", messagesToKeep: 1 });
                            await runCompartmentAgent({ client: context.client, db, sessionId, directory: context.directory, model: "mock-anthropic/mock-sonnet", historianChunkTokens: 20000, historianTimeoutMs: 15000, boundarySnapshot: boundary.snapshot, compartmentLeaseHolderId: holder, forceKeepLastCompartment: true, forceDrainQuota: true, memoryEnabled: false, preserveInjectionCacheUntilConsumed: args.deferred, onCompartmentStatePublished: () => phase(sessionId, "published") });
                            return "Control historian published";
                        } finally { releaseCompartmentLease(db, sessionId, holder); phase(sessionId, "complete"); }
                    },
                }),
            },
        };
    },
};
