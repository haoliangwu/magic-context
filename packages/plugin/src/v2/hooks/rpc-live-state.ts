import {
    createLiveSessionState,
    type LiveSessionState,
} from "../../hooks/magic-context/live-session-state";

/**
 * The RPC surface must read and write the SAME live sets the v2 pass uses.
 * `systemPromptRefreshSessions` is part of that: a `/ctx-flush` arriving over
 * RPC signals it, and only the shared instance is the one the next
 * system-prompt transform drains.
 */
export function createV2RpcLiveSessionState(
    overrides: Pick<
        LiveSessionState,
        | "liveModelBySession"
        | "variantBySession"
        | "agentBySession"
        | "channel1StateBySession"
        | "historyRefreshSessions"
        | "pendingMaterializationSessions"
        | "systemPromptRefreshSessions"
        | "sessionDirectoryBySession"
    >,
): LiveSessionState {
    return Object.assign(createLiveSessionState(), overrides);
}
