import { getSessionErrorInfo } from "../../hooks/magic-context/event-payloads";

/** Extract the terminal error supplied by host session events. */
export function hiddenTerminalError(event: { type?: string; data?: { error?: unknown } }): unknown {
    if (event.type === "session.execution.failed") return event.data?.error;
    if (event.type === "session.error") return getSessionErrorInfo(event.data)?.error;
    return undefined;
}
