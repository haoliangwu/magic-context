import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openDatabase } from "../../../plugin/src/features/magic-context/storage";
import { getDataDir } from "../../../plugin/src/shared/data-path";
import { createV2HiddenCompletionExecutor } from "../../../plugin/src/v2/hidden-completion";
import {
    HiddenChildHook,
    registerHiddenChildAgents,
} from "../../../plugin/src/v2/hooks/hidden-child";
import { gaDatabasePath, V2StoreReader } from "../../../plugin/src/v2/store-reader";

interface Command {
    seq: number;
    parentSessionID: string;
    temperature?: number;
}

export default {
    id: "mc-hidden-child-ga-proof",
    async setup(context: any) {
        const commandPath = join(context.location.directory, "hidden-child-command.json");
        const readyPath = join(context.location.directory, "hidden-child-ready");
        const db = openDatabase();
        if (!db) throw new Error("Hidden-child proof database did not open");
        const hook = new HiddenChildHook();
        await registerHiddenChildAgents(context.agent);
        await context.session.hook("context", async (draft: any) => {
            hook.apply(draft);
        });
        let agentsReady: Promise<void> | undefined;
        const executor = await createV2HiddenCompletionExecutor(context.session, {
            db,
            projectIdentity: context.location.directory,
            hook,
            ensureAgent: () => (agentsReady ??= context.agent.reload()),
            openReader: () =>
                new V2StoreReader(
                    gaDatabasePath(getDataDir(), process.env.OPENCODE_CHANNEL ?? "latest"),
                ),
            generation: "ga-proof-generation",
        });
        writeFileSync(readyPath, "ready\n");

        const run = async (command: Command) => {
            let handle: Awaited<ReturnType<typeof executor.open>> | null = null;
            let settled = false;
            try {
                handle = await executor.open({
                    parentSessionId: command.parentSessionID,
                    agent: "historian",
                    kind: "historian",
                    system: `EXACT_HISTORIAN_SYSTEM_${command.seq}`,
                    model: "openai/mock-model-cheap",
                    configuredModels: ["openai/mock-model-cheap"],
                    timeoutMs: 10_000,
                    title: "ignored shared title",
                    directory: context.location.directory,
                });
                await executor.attempt(handle, {
                    path: { id: handle.id },
                    body: {
                        model: { providerID: "openai", modelID: "mock-model-cheap" },
                        parts: [
                            {
                                type: "text",
                                text: `EXACT_HISTORIAN_CHUNK_${command.seq}`,
                                synthetic: true,
                            },
                        ],
                        ...(command.temperature === undefined
                            ? {}
                            : { temperature: command.temperature }),
                    },
                });
                const completion = await executor.collect(handle, 50);
                settled = true;
                return { ok: true, childID: handle.id, completion };
            } catch (error) {
                return {
                    ok: false,
                    childID: handle?.id ?? null,
                    error: error instanceof Error ? error.message : String(error),
                };
            } finally {
                await executor.close(handle, {
                    promptSettled: settled,
                    privacySensitive: false,
                    context: "ga-proof",
                    log() {},
                });
            }
        };

        void (async () => {
            for (;;) {
                if (!existsSync(commandPath)) {
                    await Bun.sleep(20);
                    continue;
                }
                const command = JSON.parse(readFileSync(commandPath, "utf8")) as Command;
                unlinkSync(commandPath);
                const result = await run(command);
                writeFileSync(
                    join(context.location.directory, `hidden-child-result-${command.seq}.json`),
                    JSON.stringify(result),
                );
            }
        })();
    },
};
