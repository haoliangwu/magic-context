/**
 * Conflict warning for Desktop mode when magic-context is disabled.
 *
 * - When conflicts detected: reads Desktop app state → finds active session → enqueues an RPC warning
 * - When no conflicts: cleans up any leftover warning messages from previous runs
 *
 * TUI handles this via a startup dialog — this covers Desktop only.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import { sendStatusNotification } from "../hooks/magic-context/send-session-notification";
import type { ConflictResult } from "../shared/conflict-detector";
import { formatConflictShort } from "../shared/conflict-detector";
import { log } from "../shared/logger";
import { importPluginModule } from "../shared/stale-plugin-build";

const CONFLICT_WARNING_MARKER = "⚠️ Magic Context is disabled due to conflicting configuration:";
const SCHEMA_FENCE_MARKER = "⚠️ Magic Context is disabled — database is newer than this version";
const ENABLED_MARKER = "✨ Magic Context is now enabled";
const ANNOUNCEMENT_MARKER = "✨ Magic Context — what's new in";

// --- Desktop state file resolution ---

function getDesktopStatePath(): string | null {
    const os = platform();
    const home = homedir();

    if (os === "darwin") {
        return join(
            home,
            "Library",
            "Application Support",
            "ai.opencode.desktop",
            "opencode.global.dat",
        );
    }
    if (os === "linux") {
        const xdgConfig = process.env.XDG_CONFIG_HOME || join(home, ".config");
        return join(xdgConfig, "ai.opencode.desktop", "opencode.global.dat");
    }
    if (os === "win32") {
        const appData = process.env.APPDATA || join(home, "AppData", "Roaming");
        return join(appData, "ai.opencode.desktop", "opencode.global.dat");
    }

    return null;
}

interface DesktopState {
    sessionId: string | null;
    sidecarUrl: string | null;
}

function readDesktopState(directory: string): DesktopState {
    const statePath = getDesktopStatePath();
    if (!statePath || !existsSync(statePath)) {
        log(`[magic-context] conflict-warning: Desktop state file not found at ${statePath}`);
        return { sessionId: null, sidecarUrl: null };
    }

    try {
        const raw = readFileSync(statePath, "utf-8");
        const state = JSON.parse(raw) as Record<string, unknown>;

        // Extract sidecar URL from server state
        let sidecarUrl: string | null = null;
        const serverStr = state.server;
        if (typeof serverStr === "string") {
            try {
                const serverState = JSON.parse(serverStr) as Record<string, unknown>;
                if (typeof serverState.currentSidecarUrl === "string") {
                    sidecarUrl = serverState.currentSidecarUrl;
                }
            } catch {
                // ignore parse error
            }
        }

        // Extract last session for directory
        let sessionId: string | null = null;
        const layoutPage = state["layout.page"];
        if (typeof layoutPage === "string") {
            const parsed = JSON.parse(layoutPage) as Record<string, unknown>;
            const lastProjectSession = parsed.lastProjectSession as
                | Record<string, { id?: string }>
                | undefined;
            if (lastProjectSession) {
                const entry = lastProjectSession[directory];
                sessionId = entry?.id ?? null;
            }
        }

        return { sessionId, sidecarUrl };
    } catch (error) {
        log(
            `[magic-context] conflict-warning: failed to read Desktop state: ${error instanceof Error ? error.message : String(error)}`,
        );
        return { sessionId: null, sidecarUrl: null };
    }
}

// Cache per directory so each project gets its own lookup
const cachedDesktopStateByDir = new Map<string, DesktopState>();

/** Test seam for targeting a synthetic Desktop session without touching user state files. */
export const __conflictWarningTest = {
    setDesktopState(directory: string, state: DesktopState): void {
        cachedDesktopStateByDir.set(directory, state);
    },
    reset(): void {
        cachedDesktopStateByDir.clear();
    },
};

function getDesktopState(directory: string): DesktopState {
    let cached = cachedDesktopStateByDir.get(directory);
    if (!cached) {
        cached = readDesktopState(directory);
        cachedDesktopStateByDir.set(directory, cached);
    }
    return cached;
}

// --- SDK-based message deletion ---

async function deleteMessage(
    serverUrl: string,
    sessionId: string,
    messageId: string,
): Promise<boolean> {
    // OpenCode's Session2 wrapper doesn't expose deleteMessage.
    // Use raw HTTP to the actual server URL from ctx.serverUrl.
    const auth = getServerAuth();
    const url = `${serverUrl}/session/${encodeURIComponent(sessionId)}/message/${encodeURIComponent(messageId)}`;

    try {
        const response = await fetch(url, {
            method: "DELETE",
            headers: auth ? { Authorization: auth } : {},
            signal: AbortSignal.timeout(10_000),
        });

        if (!response.ok) {
            log(
                `[magic-context] conflict-warning: DELETE failed status=${response.status} url=${url}`,
            );
            return false;
        }
        return true;
    } catch (error) {
        log(
            `[magic-context] conflict-warning: DELETE error (url=${serverUrl}): ${error instanceof Error ? error.message : String(error)}`,
        );
        return false;
    }
}

function getServerAuth(): string | undefined {
    const password = process.env.OPENCODE_SERVER_PASSWORD;
    if (!password) return undefined;
    const username = process.env.OPENCODE_SERVER_USERNAME ?? "opencode";
    return `Basic ${Buffer.from(`${username}:${password}`, "utf8").toString("base64")}`;
}

// --- Read session messages via SDK ---

type SdkMessage = {
    info?: { id?: string; role?: string; sessionID?: string };
    parts?: Array<{ type?: string; text?: string; ignored?: boolean }>;
};

async function getSessionMessages(client: unknown, sessionId: string): Promise<SdkMessage[]> {
    try {
        const c = client as {
            session?: {
                messages?: (input: {
                    path: { id: string };
                    query?: { limit?: number };
                }) => Promise<{ data?: SdkMessage[] }>;
            };
        };

        if (typeof c.session?.messages === "function") {
            // Bounded limit prevents loading the entire session into memory.
            // We only scan the tail for recent conflict warning user messages,
            // which are typically the last 1-3 messages.
            const result = await c.session.messages({
                path: { id: sessionId },
                query: { limit: 50 },
            });
            return result?.data ?? [];
        }
    } catch (error) {
        log(
            `[magic-context] conflict-warning: failed to read messages: ${error instanceof Error ? error.message : String(error)}`,
        );
    }
    return [];
}

// --- Public API ---

/**
 * Enqueue an RPC warning for the active Desktop session at plugin startup.
 */
export async function sendConflictWarning(
    client: unknown,
    directory: string,
    conflictResult: ConflictResult,
): Promise<void> {
    const { sessionId } = getDesktopState(directory);
    if (!sessionId) {
        log("[magic-context] conflict-warning: could not find active session for Desktop warning");
        return;
    }

    const warningText = formatConflictShort(conflictResult);

    log(
        `[magic-context] sending conflict warning to session ${sessionId}: ${conflictResult.reasons.join(", ")}`,
    );

    try {
        await sendStatusNotification(client, sessionId, warningText, {});
    } catch (error: unknown) {
        log(
            `[magic-context] conflict-warning: failed to send: ${error instanceof Error ? error.message : String(error)}`,
        );
    }
}

/**
 * Clean up leftover conflict warning messages from previous disabled runs.
 * Called at startup when no conflicts exist (plugin is enabled normally).
 */
export async function cleanupConflictWarnings(
    client: unknown,
    directory: string,
    serverUrl?: string,
): Promise<void> {
    const { sessionId } = getDesktopState(directory);
    if (!sessionId) {
        log("[magic-context] cleanup: no active Desktop session found");
        return;
    }
    const messages = await getSessionMessages(client, sessionId);
    if (messages.length === 0) return;

    // Scan from the end for consecutive conflict warning messages
    const warningMessageIds: string[] = [];
    for (let i = messages.length - 1; i >= 0; i--) {
        const msg = messages[i];
        const msgId = msg.info?.id;
        const msgRole = msg.info?.role;
        if (!msgId || msgRole !== "user") break;

        const parts = msg.parts ?? [];
        const isWarning =
            parts.length > 0 &&
            parts.every(
                (p) =>
                    p.ignored === true &&
                    p.type === "text" &&
                    typeof p.text === "string" &&
                    p.text.startsWith(CONFLICT_WARNING_MARKER),
            );

        if (isWarning) {
            warningMessageIds.push(msgId);
        } else {
            break; // Stop at the first non-warning message from the tail
        }
    }

    if (warningMessageIds.length === 0) {
        // Also clean up any stale "enabled" messages from previous cleanup runs
        await cleanupEnabledMessages(messages, serverUrl, sessionId);
        return;
    }

    if (!serverUrl) {
        log("[magic-context] cleanup: no serverUrl provided, cannot delete messages");
        return;
    }

    log(
        `[magic-context] cleaning up ${warningMessageIds.length} conflict warning message(s) from session ${sessionId}`,
    );

    for (const messageId of warningMessageIds) {
        const ok = await deleteMessage(serverUrl, sessionId, messageId);
        if (ok) {
            log(`[magic-context] deleted conflict warning message ${messageId}`);
        }
    }

    // Conflict resolution is status, not input to the session's next model turn.
    const enabledText = `${ENABLED_MARKER}. Enjoy! ✨`;
    try {
        await sendStatusNotification(client, sessionId, enabledText, {});
    } catch {
        // Best-effort — don't log noise if this fails
    }
}

/** Remove any leftover "enabled" messages that survived from a previous cleanup run */
async function cleanupEnabledMessages(
    messages: SdkMessage[],
    serverUrl: string | undefined,
    sessionId: string,
): Promise<void> {
    if (!serverUrl) return;
    for (let i = messages.length - 1; i >= 0; i--) {
        const msg = messages[i];
        const msgId = msg.info?.id;
        const msgRole = msg.info?.role;
        if (!msgId || msgRole !== "user") break;

        const parts = msg.parts ?? [];
        const isEnabled =
            parts.length > 0 &&
            parts.every(
                (p) =>
                    p.ignored === true &&
                    p.type === "text" &&
                    typeof p.text === "string" &&
                    p.text.startsWith(ENABLED_MARKER),
            );

        if (isEnabled) {
            await deleteMessage(serverUrl, sessionId, msgId);
        } else {
            break;
        }
    }
}

/**
 * Desktop schema-fence warning. When OpenCode and Pi share context.db and one
 * harness auto-updates first, it migrates the DB to a newer schema; the lagging
 * harness then fail-closes and disables ALL of Magic Context. Previously this
 * was log-only, so the user just saw the plugin silently stop working. Surface
 * an RPC warning telling them what happened and how to fix it. The schema fence
 * remains visible in status diagnostics until the lagging harness is updated.
 */
export async function sendSchemaFenceWarning(
    client: unknown,
    directory: string,
    detail: { persistedVersion: number; supportedVersion: number },
): Promise<void> {
    const { sessionId } = getDesktopState(directory);
    if (!sessionId) return;

    const text = [
        `${SCHEMA_FENCE_MARKER}`,
        "",
        `The shared Magic Context database was upgraded to schema v${detail.persistedVersion} by a`,
        `newer build (OpenCode and Pi share one database). This build only supports`,
        `up to v${detail.supportedVersion}, so it has fail-closed to avoid corrupting the cache.`,
        "",
        "This usually means a pinned or stale plugin is sharing the database with a",
        "newer instance. Update or unpin Magic Context on this harness (or update",
        "OpenCode/Pi) to the latest version, then restart. The fastest fix is:",
        "",
        "  npx @cortexkit/magic-context@latest doctor --force",
        "",
        "Your data is safe; nothing is disabled permanently.",
    ].join("\n");

    try {
        await sendStatusNotification(client, sessionId, text, {});
    } catch {
        return;
    }
}

/**
 * Desktop startup announcement: enqueue a one-shot RPC notification describing
 * what's new in this release. Mirrors the TUI's RPC-driven dialog path so both
 * surfaces deliver the same announcement once per ANNOUNCEMENT_VERSION.
 *
 * Persistence lives in `getMagicContextStorageDir()/last_announced_version`,
 * shared with the TUI handlers and the Pi plugin so a dismissal in any harness
 * suppresses the others for the same announcement.
 */
export async function sendStartupAnnouncement(
    client: unknown,
    directory: string,
    version: string,
    features: ReadonlyArray<string>,
    footer: string,
    markSeen: (version: string) => void,
): Promise<void> {
    if (!version || features.length === 0) return;

    const { sessionId } = getDesktopState(directory);
    if (!sessionId) {
        // No active Desktop session — TUI will pick it up next time it loads.
        // The persistence file is the same across surfaces, so this is correct.
        return;
    }

    // TUI owns the announcement dialog and shared dismissal stamp. Do not race
    // it with an RPC toast when any TUI is connected, even for another session.
    const { isTuiConnected } = await importPluginModule(
        () => import("../shared/rpc-notifications"),
    );
    if (isTuiConnected(sessionId) || isTuiConnected()) return;

    // Toast payloads are plain text, so retain copyable URLs instead of Markdown links.
    const bullets = features.map((line) => `  • ${line}`).join("\n");
    const sections = [`${ANNOUNCEMENT_MARKER} v${version}:`, "", bullets];
    if (footer && footer.trim().length > 0) {
        // Blank-line separator distinguishes the persistent footer (Discord
        // invite, etc.) from the version-specific bullets.
        sections.push("", footer);
    }
    const text = sections.join("\n");

    log(`[magic-context] sending startup announcement for v${version} to session ${sessionId}`);

    try {
        await sendStatusNotification(client, sessionId, text, {
            // Mark the announcement once its RPC notification has been enqueued.
            onDelivered: () => markSeen(version),
        });
    } catch (error: unknown) {
        log(
            `[magic-context] announcement: failed to send: ${error instanceof Error ? error.message : String(error)}`,
        );
    }
}
