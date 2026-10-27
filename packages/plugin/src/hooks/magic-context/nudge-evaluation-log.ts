import { sessionLog } from "../../shared/logger";
import { diagnosticStateChanged } from "./diagnostic-log-state";

/** Keep the full measurement line on decision transitions, not on every token delta. */
export function logNudgeEvaluation(sessionId: string, phase: string, line: string): void {
    const category = `${phase}:${line.split(":", 1)[0]}`;
    const state = line
        .split(" ")
        .filter((field) => /^(ctx_reduce|band|dampening|verdict|reason|lease)=/.test(field))
        .join(" ");
    if (diagnosticStateChanged(sessionId, category, state)) sessionLog(sessionId, line);
}
