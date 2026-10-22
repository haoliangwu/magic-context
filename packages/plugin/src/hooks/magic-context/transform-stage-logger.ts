import { AsyncLocalStorage } from "node:async_hooks";
import { sessionLog } from "../../shared/logger";

const SLOW_STAGE_MS = 100;
const passes = new AsyncLocalStorage<{
    sessionId?: string;
    stages: string[];
    slow: string[];
    closed: boolean;
}>();

/** Scope timings to the request, including overlapping passes and early returns. */
export async function withTransformTimingSummary<T>(run: () => Promise<T>): Promise<T> {
    const pass = {
        stages: [] as string[],
        slow: [] as string[],
        closed: false,
        sessionId: undefined as string | undefined,
    };
    return passes.run(pass, async () => {
        try {
            return await run();
        } finally {
            pass.closed = true;
            if (pass.sessionId)
                sessionLog(
                    pass.sessionId,
                    `transform stages: ${pass.stages.join(" ")} slow>=${SLOW_STAGE_MS}ms=[${pass.slow.join(",")}]`,
                );
        }
    });
}

export function logTransformElapsed(
    sessionId: string,
    stage: string,
    elapsedMs: number,
    extra?: string,
): void {
    const elapsed = elapsedMs.toFixed(1);
    const suffix = extra ? ` ${extra}` : "";
    const pass = passes.getStore();
    if (pass && !pass.closed) {
        pass.sessionId = sessionId;
        pass.stages.push(`${stage}=${elapsed}ms${extra ? `(${extra})` : ""}`);
        if (elapsedMs >= SLOW_STAGE_MS) pass.slow.push(stage);
    }
    if (elapsedMs >= SLOW_STAGE_MS)
        sessionLog(sessionId, `transform stage: stage=${stage} elapsed=${elapsed}ms${suffix}`);
}

export function logTransformTiming(
    sessionId: string,
    stage: string,
    startMs: number,
    extra?: string,
): void {
    logTransformElapsed(sessionId, stage, performance.now() - startMs, extra);
}
