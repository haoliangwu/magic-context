import { sessionLog } from "../../shared/logger";

export function startHistorianPublishStage(
    sessionId: string,
    stage: string,
    extra?: string,
): number {
    const suffix = extra ? ` ${extra}` : "";
    sessionLog(
        sessionId,
        `historian publish stage: stage=${stage} status=started elapsed=0.0ms${suffix}`,
    );
    return performance.now();
}

export function finishHistorianPublishStage(
    sessionId: string,
    stage: string,
    startMs: number,
    status: "completed" | "discarded" | "failed" | "scheduled" = "completed",
    extra?: string,
): void {
    const elapsed = (performance.now() - startMs).toFixed(1);
    const suffix = extra ? ` ${extra}` : "";
    sessionLog(
        sessionId,
        `historian publish stage: stage=${stage} status=${status} elapsed=${elapsed}ms${suffix}`,
    );
}
