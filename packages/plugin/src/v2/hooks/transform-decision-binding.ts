import {
    bindOpenCodeV2TransformDecision,
    type V2DecisionAssistant,
} from "../../features/magic-context/transform-decision-log";
import { lkgProviderInputTotal } from "../../hooks/magic-context/lkg-measured-request";
import {
    isSuccessfulProviderCompletion,
    providerResponseFailed,
} from "../../shared/provider-response-completion";
import type { V2StoreReader } from "../store-reader";

/**
 * Bind the transform decision staged by the previous OpenCode 2 context pass to
 * the reply of that pass's request: the first assistant row written after the
 * store sequence captured before the request was sent. Best-effort telemetry;
 * it never throws into the context pass.
 */
export function bindV2TransformDecision(args: {
    db: Parameters<typeof bindOpenCodeV2TransformDecision>[0]["db"];
    sessionId: string;
    reader: Pick<V2StoreReader, "assistantSince">;
    passStarting: boolean;
}): boolean {
    try {
        return bindOpenCodeV2TransformDecision({
            db: args.db,
            sessionId: args.sessionId,
            passStarting: args.passStarting,
            firstAssistantAfter: (sequence): V2DecisionAssistant | undefined => {
                const first = args.reader.assistantSince(args.sessionId, sequence)[0];
                if (!first) return undefined;
                const completion = {
                    completedAt: first.data.time?.completed,
                    finish: first.data.finish,
                    error: first.data.error,
                };
                return {
                    id: first.id,
                    state: providerResponseFailed(completion)
                        ? "failed"
                        : isSuccessfulProviderCompletion(completion)
                          ? "succeeded"
                          : "running",
                    inputTokens: lkgProviderInputTotal(first.data.tokens),
                };
            },
        });
    } catch {
        return false;
    }
}
