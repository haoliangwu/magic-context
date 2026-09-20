import { sessionLog } from "../../shared/logger";
import { deliverSyntheticUserMessage } from "./channel2-delivery";
import { ENGINE_RECONNECTING_USER_MESSAGE } from "./emergency-fail-closed";
import { latestPersistedMessageForRecovery } from "./read-session-db";
import type { RustModeModuleClient } from "./rust-mode-transform";

export const RUST_REFUSAL_RECOVERY_PROMPT =
    "Magic Context's engine reconnected. Continue from where you stopped.";
export const RUST_REFUSAL_RECOVERY_POLL_MS = 2_000;
export const RUST_REFUSAL_RECOVERY_MAX_MS = 5 * 60_000;
export const RUST_REFUSAL_RECOVERY_PROBE_TIMEOUT_MS = 2_000;

interface RecoveryWatcher {
    refusalKey: string;
    refusedUserMessageId: string;
    projectRoot: string;
    armedAtMs: number;
    state: "pending" | "claimed";
    timer?: ReturnType<typeof setTimeout>;
}

export interface RustRefusalRecoveryOptions {
    moduleClient: RustModeModuleClient;
    client: unknown;
    pollIntervalMs?: number;
    maxDurationMs?: number;
    probeTimeoutMs?: number;
    readLatestMessage?: typeof latestPersistedMessageForRecovery;
}

function errorContainsReconnectRefusal(error: unknown): boolean {
    try {
        return JSON.stringify(error).includes(ENGINE_RECONNECTING_USER_MESSAGE);
    } catch {
        return false;
    }
}

export function createRustRefusalRecovery(options: RustRefusalRecoveryOptions) {
    const watchers = new Map<string, RecoveryWatcher>();
    const latestRefusalBySession = new Map<string, string>();
    const pollIntervalMs = options.pollIntervalMs ?? RUST_REFUSAL_RECOVERY_POLL_MS;
    const maxDurationMs = options.maxDurationMs ?? RUST_REFUSAL_RECOVERY_MAX_MS;
    const probeTimeoutMs = options.probeTimeoutMs ?? RUST_REFUSAL_RECOVERY_PROBE_TIMEOUT_MS;
    const readLatestMessage = options.readLatestMessage ?? latestPersistedMessageForRecovery;

    const cancel = (sessionId: string): void => {
        const watcher = watchers.get(sessionId);
        if (!watcher) return;
        clearTimeout(watcher.timer);
        watchers.delete(sessionId);
    };

    const schedule = (sessionId: string, watcher: RecoveryWatcher): void => {
        watcher.timer = setTimeout(() => void poll(sessionId, watcher), pollIntervalMs);
    };

    const probe = async (watcher: RecoveryWatcher, sessionId: string): Promise<boolean> => {
        const controller = new AbortController();
        const timeoutError = new Error("rust refusal recovery probe timed out");
        const timer = setTimeout(() => controller.abort(timeoutError), probeTimeoutMs);
        try {
            await Promise.race([
                options.moduleClient.call({
                    sessionId,
                    projectRoot: watcher.projectRoot,
                    method: "session.status",
                    body: { method: "session.status", v: 1, session_id: sessionId },
                    signal: controller.signal,
                    timeoutMs: probeTimeoutMs,
                    bypassSessionLane: true,
                }),
                new Promise<never>((_resolve, reject) => {
                    controller.signal.addEventListener(
                        "abort",
                        () => reject(controller.signal.reason ?? timeoutError),
                        { once: true },
                    );
                }),
            ]);
            return true;
        } catch {
            return false;
        } finally {
            clearTimeout(timer);
        }
    };

    const poll = async (sessionId: string, watcher: RecoveryWatcher): Promise<void> => {
        if (watchers.get(sessionId) !== watcher) return;
        if (Date.now() - watcher.armedAtMs >= maxDurationMs) {
            cancel(sessionId);
            sessionLog(sessionId, "rust refusal recovery expired before the module became healthy");
            return;
        }
        if (!(await probe(watcher, sessionId))) {
            schedule(sessionId, watcher);
            return;
        }

        let latest: ReturnType<typeof latestPersistedMessageForRecovery>;
        try {
            latest = readLatestMessage(sessionId);
        } catch (error) {
            sessionLog(sessionId, "rust refusal recovery could not read persisted history:", error);
            schedule(sessionId, watcher);
            return;
        }
        // OpenCode persists the assistant shell before it records a transform error. The arm
        // already proves this exact user turn was refused, so its unfinished assistant child is
        // still the refused step; a completed child without the refusal error is not.
        const matchingAssistant =
            latest?.role === "assistant" &&
            (latest.parentID === undefined || latest.parentID === watcher.refusedUserMessageId)
                ? latest
                : null;
        const stillRefusedStep =
            matchingAssistant !== null &&
            (errorContainsReconnectRefusal(matchingAssistant.error) ||
                (matchingAssistant.parentID === watcher.refusedUserMessageId &&
                    matchingAssistant.error === undefined &&
                    matchingAssistant.completedAt === undefined));
        if (!stillRefusedStep) {
            cancel(sessionId);
            sessionLog(
                sessionId,
                "rust refusal recovery skipped because persisted history advanced past the refused step",
            );
            return;
        }

        if (watcher.state !== "pending" || watchers.get(sessionId) !== watcher) return;
        watcher.state = "claimed";
        const delivered = await deliverSyntheticUserMessage(sessionId, {
            client: options.client,
            text: RUST_REFUSAL_RECOVERY_PROMPT,
            beforeSend: () => watchers.get(sessionId) === watcher && watcher.state === "claimed",
        }).catch((error) => {
            sessionLog(sessionId, "rust refusal recovery synthetic delivery failed:", error);
            return false;
        });
        if (!delivered) {
            if (watchers.get(sessionId) === watcher) {
                watcher.state = "pending";
                schedule(sessionId, watcher);
            }
            return;
        }
        watchers.delete(sessionId);
        sessionLog(sessionId, "rust refusal recovery synthetic continue delivered");
    };

    return {
        arm(args: {
            sessionId: string;
            projectRoot: string;
            refusedUserMessageId: string;
            providerProvenEmergency: boolean;
            compactionOff: boolean;
        }): void {
            if (args.compactionOff || args.providerProvenEmergency) return;
            const refusalKey = `${args.sessionId}:${args.refusedUserMessageId}`;
            if (latestRefusalBySession.get(args.sessionId) === refusalKey) return;
            latestRefusalBySession.set(args.sessionId, refusalKey);
            const current = watchers.get(args.sessionId);
            if (current) cancel(args.sessionId);
            const watcher: RecoveryWatcher = {
                refusalKey,
                refusedUserMessageId: args.refusedUserMessageId,
                projectRoot: args.projectRoot,
                armedAtMs: Date.now(),
                state: "pending",
            };
            watchers.set(args.sessionId, watcher);
            schedule(args.sessionId, watcher);
            sessionLog(args.sessionId, `rust refusal recovery armed refusal=${refusalKey}`);
        },
        cancel,
        forget(sessionId: string): void {
            cancel(sessionId);
            latestRefusalBySession.delete(sessionId);
        },
        activeCountForTests(): number {
            return watchers.size;
        },
    };
}

export type RustRefusalRecovery = ReturnType<typeof createRustRefusalRecovery>;
