import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { COMPARTMENT_AGENT_SYSTEM_PROMPT } from "../../plugin/src/hooks/magic-context/historian-prompt.generated";
import { buildReferenceBlocks } from "../../plugin/src/hooks/magic-context/reference-retrieval";
import { buildCompartmentAgentPrompt } from "../../plugin/src/hooks/magic-context/compartment-prompt";
import { buildHistorianRepairPrompt } from "../../plugin/src/hooks/magic-context/compartment-runner-validation";
import { openDatabase } from "../../plugin/src/features/magic-context/storage";
import { getDataDir } from "../../plugin/src/shared/data-path";
import { createV2HiddenCompletionExecutor } from "../../plugin/src/v2/hidden-completion";
import { nativeSessionRemove } from "../../plugin/src/v2/hidden-child-native";
import { HiddenChildHook, registerHiddenChildAgents } from "../../plugin/src/v2/hooks/hidden-child";
import { gaDatabasePath, V2StoreReader } from "../../plugin/src/v2/store-reader";

export const fixtureSystem = COMPARTMENT_AGENT_SYSTEM_PROMPT;
export const fixturePrompt = buildCompartmentAgentPrompt({ ...buildReferenceBlocks({ sessionId: "cache-proof", chunkStart: 1, sessionCompartments: [] }), projectMemory: "", inputSource: "Messages 1-2:\n\nUser: inspect caching.\nAssistant: cache the stable prefix.", memoryEnabled: false });

export default {
    id: "mc-cache-tail-proof",
    async setup(context: any) {
        const hook = new HiddenChildHook();
        const wire: unknown[] = [];
        await registerHiddenChildAgents(context.agent);
        await context.session.hook("context", (draft: any) => { hook.apply(draft); });
        await context.session.hook("http.request", async (draft: any) => {
            const before = await draft.request.clone().text();
            await hook.cacheRequest(draft);
            const after = await draft.request.clone().text();
            wire.push({ sessionID: draft.sessionID, owned: hook.owns(draft.sessionID), kind: draft.kind, before, after });
            writeFileSync(join(context.location.directory, "cache-wire.json"), JSON.stringify(wire));
        });
        const db = openDatabase();
        if (!db) throw new Error("Cache proof database did not open");
        const executor = await createV2HiddenCompletionExecutor({ ...context.session, removeSession: nativeSessionRemove(context.session) }, {
            db, directory: context.location.directory, projectIdentity: context.location.directory,
            hook, ensureAgent: () => context.agent.reload(), generation: "cache-proof",
            openReader: () => new V2StoreReader(gaDatabasePath(getDataDir(), process.env.OPENCODE_CHANNEL ?? "latest")),
        });
        await context.session.hook("generate", async (draft: any) => {
            const command = draft.messages.at(-1)?.content?.[0]?.text;
            if (command !== "CACHE_PROOF") return;
            try {
            const handle = await executor.open({parentSessionId: draft.sessionID, agent: "historian", kind: "historian", system: fixtureSystem, model: "anthropic/mock-model", timeoutMs: 15000, title: "cache-proof", directory: context.location.directory});
            try {
                const repair = buildHistorianRepairPrompt(fixturePrompt, "invalid XML", "missing compartment", "en");
                for (const [cacheTail, prompt] of [["write", fixturePrompt], ["skip", fixturePrompt], ["write", fixturePrompt], ["write", repair], ["skip", repair]] as const) {
                    await executor.attempt(handle, {path: {id: handle.id}, cacheTail, body: {system: fixtureSystem, parts: [{type: "text", text: prompt}]}});
                    await executor.collect(handle, 50);
                }
                writeFileSync(join(context.location.directory, "cache-proof.done"), "ok");
            } finally {
                await executor.close(handle, {promptSettled: true, privacySensitive: false, context: "cache-proof", log: () => {}});
            }
            } catch (error) {
                writeFileSync(join(context.location.directory, "cache-proof.error"), String(error) + "\n" + (error as Error).stack);
                throw error;
            }
            throw new Error("CACHE_PROOF_COMPLETE");
        });
    },
};
