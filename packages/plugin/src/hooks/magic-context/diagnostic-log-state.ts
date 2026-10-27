import { BoundedSessionMap } from "../../shared/bounded-session-map";
import { getMagicContextStorageDir } from "../../shared/data-path";
import { getHarness } from "../../shared/harness";

const states = new BoundedSessionMap<Map<string, string>>(1000);
const scope = (sessionId: string) =>
    `${getMagicContextStorageDir()}\0${getHarness()}\0${sessionId}`;

/** Remember decisions, not changing measurements, so a hold logs again after recovery. */
export function diagnosticStateChanged(
    sessionId: string,
    category: string,
    state: string,
): boolean {
    const key = scope(sessionId);
    const previous = states.get(key) ?? new Map<string, string>();
    if (previous.get(category) === state) return false;
    previous.set(category, state);
    states.set(key, previous);
    return true;
}

export function clearDiagnosticLogState(sessionId: string): void {
    states.delete(scope(sessionId));
}
