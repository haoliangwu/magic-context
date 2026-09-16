import type { DreamerConfig } from "../../config/schema/magic-context";
import { buildDreamTaskRuntimeConfigs } from "../../features/magic-context/dreamer/task-config";
import { createDreamTaskExecutor } from "../../features/magic-context/dreamer/task-executor";
import { runDueTasksForProject } from "../../features/magic-context/dreamer/task-scheduler";
import { openDatabase } from "../../features/magic-context/storage";
import type { HiddenCompletionExecutor } from "../../hooks/magic-context/compartment-runner-types";
import type { V2Context } from "./types";

/** The event carrier only wakes the shared scheduler; it never implements another
 * queue or task loop. Generate completions have no execution-ended event, so a hidden
 * completion cannot recursively schedule itself through this subscription. */
export function startDreamTrigger(
    context: V2Context,
    args: {
        config: DreamerConfig;
        executor: HiddenCompletionExecutor;
        projectIdentity: () => string;
        language?: string;
        mural?: { enabled: boolean; model?: string };
    },
) {
    const controller = new AbortController();
    const done = (async () => {
        try {
            for await (const value of context.event.subscribe({ signal: controller.signal })) {
                if (controller.signal.aborted) break;
                const event = value as { type?: string; data?: { sessionID?: string } };
                if (event.type !== "session.execution.succeeded" || !event.data?.sessionID)
                    continue;
                const db = openDatabase();
                if (!db) continue;
                try {
                    await runDueTasksForProject({
                        db,
                        projectIdentity: args.projectIdentity(),
                        tasks: buildDreamTaskRuntimeConfigs(
                            args.config,
                            "opencode",
                            args.language,
                            args.mural?.model,
                        ),
                        executor: createDreamTaskExecutor({
                            hiddenCompletionExecutor: args.executor,
                            parentSessionId: event.data.sessionID,
                            sessionDirectory: context.location.directory,
                            openOpenCodeDb: () => null,
                            language: args.language,
                            mural: args.mural,
                        }),
                    });
                } catch (error) {
                    console.warn("[magic-context] v2 dream scheduling failed", error);
                }
            }
        } catch (error) {
            if (!controller.signal.aborted)
                console.warn("[magic-context] v2 dream event subscription failed", error);
        }
    })();
    return {
        async dispose() {
            controller.abort();
            await done;
        },
    };
}
