import { createSubcModuleClient } from "../../hooks/magic-context/module-client";
import type { RustModeModuleClient } from "../../hooks/magic-context/rust-mode-transform";
import {
    createRustRefusalRecovery,
    type RustRefusalRecovery,
    type RustRefusalRecoveryOptions,
} from "../../hooks/magic-context/rust-refusal-recovery";
import type { StoreRow } from "../store-reader";
import { deliverSynthetic } from "./channel2";
import type { V2Context } from "./types";

/** Conversational row types the v2 projection treats as a user turn. */
const USER_TURN_TYPES = new Set(["user", "synthetic", "skill", "shell", "system"]);

/**
 * Build the module client for this lane when Rust mode is the configured mode.
 *
 * Returns undefined for TypeScript mode so every later reader — the transform,
 * the RPC status handlers, the sidebar — sees the same "no module here" answer
 * rather than each deciding for itself.
 */
export function resolveV2RustModeModuleClient(
    config: { transform_mode?: "ts" | "rust"; subc?: { connection_file?: string } },
    directory: string,
): RustModeModuleClient | undefined {
    if (config.transform_mode !== "rust") return undefined;
    return createSubcModuleClient({
        ...(config.subc?.connection_file !== undefined
            ? { connectionFile: config.subc.connection_file }
            : {}),
        projectRoot: directory,
    });
}

/**
 * Whether the refused turn is still the step the conversation is waiting on.
 *
 * The answer comes from the v2 store's own rows. A user turn recorded after the
 * refused one means the user already retried or moved on, and delivering the
 * synthetic continue then would inject an instruction about a turn nobody is
 * waiting for any more.
 */
export function refusedStepStillCurrent(
    rows: readonly StoreRow[],
    refusedUserMessageId: string,
): boolean {
    const refused = rows.findIndex((row) => row.id === refusedUserMessageId);
    if (refused < 0) return false;
    return !rows.slice(refused + 1).some((row) => USER_TURN_TYPES.has(row.type));
}

/**
 * Refusal recovery for Rust mode on OpenCode 2.
 *
 * The behavior is the OpenCode 1 behavior; only the two host-owned edges move.
 * The synthetic continue goes out through this host's own synthetic carrier, the
 * same one Channel 2 nudges use, so the message is admitted and recognized like
 * every other Magic Context synthetic. The "has the conversation moved on?" check
 * reads the v2 store rather than OpenCode 1's message table, which on this host
 * holds a different session's history or no history at all.
 */
export function createV2RustRefusalRecovery(
    args: {
        context: Pick<V2Context, "session" | "storage">;
        moduleClient: RustModeModuleClient;
        /**
         * The session's rows from `messageID` onward, oldest first; empty when the
         * message is not in the store. Bounded to the tail so a long session is
         * never read whole on a refusal poll.
         */
        readRowsFrom: (sessionID: string, messageID: string) => readonly StoreRow[];
    } & Pick<RustRefusalRecoveryOptions, "pollIntervalMs" | "maxDurationMs" | "probeTimeoutMs">,
): RustRefusalRecovery {
    return createRustRefusalRecovery({
        ...(args.pollIntervalMs !== undefined ? { pollIntervalMs: args.pollIntervalMs } : {}),
        ...(args.maxDurationMs !== undefined ? { maxDurationMs: args.maxDurationMs } : {}),
        ...(args.probeTimeoutMs !== undefined ? { probeTimeoutMs: args.probeTimeoutMs } : {}),
        moduleClient: args.moduleClient,
        client: undefined,
        deliverSynthetic: async ({ sessionId, text, beforeSend }) => {
            if (!beforeSend()) return false;
            await deliverSynthetic(args.context, sessionId, text);
            return true;
        },
        isRefusedStepStillCurrent: (sessionId, refusedUserMessageId) =>
            refusedStepStillCurrent(
                args.readRowsFrom(sessionId, refusedUserMessageId),
                refusedUserMessageId,
            ),
    });
}
