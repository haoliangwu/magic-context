import type { RustToolBackends } from "../../plugin/rust-tool-backends";
import type { Database } from "../../shared/sqlite";
import type { RustModeModuleClient } from "./rust-mode-transform";

export interface ModuleToolBackends {
    backends: RustToolBackends;
}

/** Memory and note tools write context.db directly; only drop state lives in the module. */
export function createModuleToolBackends(options: {
    db: Database;
    moduleClient: RustModeModuleClient | undefined;
    directory: string;
    memorySyncRequestedSessions: Set<string>;
}): ModuleToolBackends | undefined {
    const { moduleClient } = options;
    if (!moduleClient) return undefined;
    return {
        backends: {
            reduce: ({ sessionId, projectRoot, drop, commandId }) =>
                moduleClient.call({
                    sessionId,
                    projectRoot,
                    method: "agent_drops.append",
                    body: {
                        method: "agent_drops.append",
                        v: 1,
                        session_id: sessionId,
                        drop,
                        command_id: commandId,
                    },
                }),
        },
    };
}
