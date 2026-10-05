import { FAIL_CLOSED_DOCTOR_COMMAND } from "../../features/magic-context/fail-closed-block";
import {
    type ChildSpawnFenceFailure,
    probeChildSpawnFence,
} from "../../features/magic-context/schema-fence-probe";
import { updateSessionMeta } from "../../features/magic-context/storage";
import { sessionLog } from "../../shared/logger";
import { pushNotification } from "../../shared/rpc-notifications";
import type { Database } from "../../shared/sqlite";
import type { NotificationParams } from "./send-session-notification";

export const STALE_PLUGIN_RESTART_NOTICE =
    "Magic Context: plugin build is older than its database — restart OpenCode";
export const SCHEMA_PROBE_FAILURE_NOTICE = `Magic Context: unable to verify the database schema before spawning a child — run ${FAIL_CLOSED_DOCTOR_COMMAND}`;

interface ChildSessionClient {
    /** True only for clients whose background work cannot appear in a user's session list. */
    backgroundSessionsAreHidden?: boolean;
    session: { create(input: never): unknown | Promise<unknown> };
}

interface ChildSessionSpawnArgs {
    client: ChildSessionClient;
    db: Database | null;
    parentSessionId?: string;
    title: string;
    directory?: string;
    notificationParams?: NotificationParams;
    /** Test seam for the one-shot, N-consecutive failure surface. */
    onFenceLatched?: (failure: ChildSpawnFenceFailure) => void | Promise<void>;
}

async function surfaceSchemaFenceFailure(
    args: ChildSessionSpawnArgs,
    failure: ChildSpawnFenceFailure,
): Promise<void> {
    if (!args.parentSessionId) return;
    const notice =
        failure.reason === "read_error" ? SCHEMA_PROBE_FAILURE_NOTICE : STALE_PLUGIN_RESTART_NOTICE;
    if (args.db) {
        try {
            updateSessionMeta(args.db, args.parentSessionId, {
                lastTransformError: notice,
            });
        } catch (error) {
            sessionLog(
                args.parentSessionId,
                `schema-fence warning persistence failed: ${error instanceof Error ? error.message : String(error)}`,
            );
        }
    }
    try {
        pushNotification(
            "toast",
            {
                title: "Magic Context",
                message: notice,
                variant: "error",
                duration: 10_000,
            },
            args.parentSessionId,
        );
        // The toast's companion action makes the persisted sidebar error visible
        // immediately instead of waiting for the next session event or poll.
        pushNotification("action", { action: "refresh-sidebar" }, args.parentSessionId);
    } catch (error) {
        sessionLog(
            args.parentSessionId,
            `schema-fence warning delivery failed: ${error instanceof Error ? error.message : String(error)}`,
        );
    }
}

/**
 * Shared OpenCode child-session choke point. Every historian/recomp and Dreamer
 * child must pass this probe before asking OpenCode to create it.
 */
export async function createChildSessionWithFence(
    args: ChildSessionSpawnArgs,
): Promise<unknown | null> {
    const verdict = probeChildSpawnFence(args.db);
    if (!verdict.allowSpawn) {
        if (args.parentSessionId) {
            sessionLog(
                args.parentSessionId,
                `child session skipped (${verdict.failure.failureClass}): database=v${verdict.failure.persistedVersion}, supported_fence=v${verdict.failure.supportedVersion}, consecutive=${verdict.failure.consecutiveFailures}, total=${verdict.failure.totalFailures}`,
            );
        }
        if (verdict.shouldSurface) {
            if (args.onFenceLatched) await args.onFenceLatched(verdict.failure);
            else await surfaceSchemaFenceFailure(args, verdict.failure);
        }
        return null;
    }

    // Agent.hidden only hides the agent picker. OpenCode's session picker and
    // Desktop error notifications use parentID, so background work must wait
    // for an ordinary session rather than creating a visible root at startup.
    if (
        args.title.startsWith("magic-context-dream") &&
        !args.parentSessionId &&
        !args.client.backgroundSessionsAreHidden
    ) {
        sessionLog("dreamer", "child session deferred: no parent session is available");
        return null;
    }

    return args.client.session.create({
        body: {
            ...(args.parentSessionId ? { parentID: args.parentSessionId } : {}),
            title: args.title,
        },
        query: { directory: args.directory },
    } as never);
}
