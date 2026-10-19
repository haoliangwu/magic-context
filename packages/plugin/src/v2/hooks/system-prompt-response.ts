import { currentLkgRequestIdentity } from "../../hooks/magic-context/lkg-measured-request";
import { bindSystemPromptResponse } from "../../hooks/magic-context/system-prompt-delivery";
import type { V2StoreReader } from "../store-reader";

/** The newest assistant may belong to a later concurrent run. Bind only the
 * first assistant row after the prepared request's captured store boundary. */
export function bindV2SystemPromptResponse(
    sessionId: string,
    reader: Pick<V2StoreReader, "assistantSince">,
): void {
    const request = currentLkgRequestIdentity(sessionId);
    if (request?.kind !== "v2" || request.responseAfterSequence === undefined) return;
    const first = reader.assistantSince(sessionId, request.responseAfterSequence)[0];
    if (!first) return;
    const createdAt = first.data.time?.created ?? first.time_created;
    if (typeof createdAt !== "number") return;
    bindSystemPromptResponse(sessionId, request, {
        responseId: first.id,
        createdAt,
        modelKey:
            first.data.model?.providerID && first.data.model?.id
                ? `${first.data.model.providerID}/${first.data.model.id}`
                : undefined,
    });
}
