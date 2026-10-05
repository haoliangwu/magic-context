import { shouldKeepSubagents } from "./keep-subagents";

interface ChildSessionRequest {
    path: { id: string };
    query?: { directory: string };
}

interface ArchiveChildSessionRequest extends ChildSessionRequest {
    body: { time: { archived: number } };
}

export interface ChildSessionTeardownClient {
    session: {
        delete(request: ChildSessionRequest): Promise<unknown>;
    };
}

export interface TeardownChildSessionArgs {
    client: ChildSessionTeardownClient;
    sessionId: string | null;
    sessionDirectory?: string;
    promptSettled: boolean;
    privacySensitive: boolean;
    context: string;
    log: (message: string) => void;
}

/**
 * Retire a child only after its prompt helper resolves. An unresolved client call
 * can leave OpenCode's server loop writing, so that row is archived for immediate
 * UI hiding and retained until the age-gated sweep can delete it safely.
 *
 * OpenCode's generated v2 SDK models archival as `session.update` with
 * `time.archived`; the plugin's legacy path/body client reaches the same PATCH
 * endpoint, although its generated TypeScript body type does not yet expose time.
 */
export async function teardownChildSession(args: TeardownChildSessionArgs): Promise<void> {
    const { client, sessionId, sessionDirectory, promptSettled, context, log } = args;
    if (!sessionId) return;

    const request: ChildSessionRequest = {
        path: { id: sessionId },
        ...(sessionDirectory ? { query: { directory: sessionDirectory } } : {}),
    };

    // Retention keeps every settled child; only unsettled children go to the age-gated sweep.
    if (promptSettled && !shouldKeepSubagents()) {
        await client.session.delete(request).catch((error: unknown) => {
            log(`${context}: session cleanup failed: ${String(error)}`);
        });
        return;
    }

    if (!promptSettled) {
        const archiveSession = client.session as unknown as {
            update?: (request: ArchiveChildSessionRequest) => Promise<unknown>;
        };
        await archiveSession
            .update?.({
                ...request,
                body: { time: { archived: Date.now() } },
            })
            .catch(() => {});
        log(`${context}: prompt unsettled — session ${sessionId} left to the age-gated sweep`);
    }
}
