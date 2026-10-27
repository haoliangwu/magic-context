import { expect, spyOn, test } from "bun:test";
import * as logger from "../../shared/logger";
import { clearDiagnosticLogState } from "./diagnostic-log-state";
import { logNudgeEvaluation } from "./nudge-evaluation-log";

test("nudge logs suppress numeric drift but retain verdict, lease, phase and recovery transitions", () => {
    const id = "nudge-log-transitions";
    clearDiagnosticLogState(id);
    const log = spyOn(logger, "sessionLog").mockImplementation(() => {});
    const logged = () => log.mock.calls.filter((call) => call[0] === id);
    const line = (tokens: number, verdict = "hold", lease = "empty->empty") =>
        `channel2 evaluation: ctx_reduce=callable U=${tokens} T=100000 ratio=0.1000 band=quiet lease=${lease} verdict=${verdict} reason=ratio-below-ceiling`;
    try {
        logNudgeEvaluation(id, "transform", line(1000));
        logNudgeEvaluation(id, "transform", line(2000));
        expect(logged()).toHaveLength(1);
        logNudgeEvaluation(id, "transform", line(2000, "arm", "empty->pending"));
        logNudgeEvaluation(id, "transform", line(3000));
        expect(logged()).toHaveLength(3);
        logNudgeEvaluation(id, "delivery", line(3000));
        expect(logged()).toHaveLength(4);
        clearDiagnosticLogState(id);
        logNudgeEvaluation(id, "transform", line(3000));
        expect(logged()).toHaveLength(5);
    } finally {
        log.mockRestore();
        clearDiagnosticLogState(id);
    }
});
