import { getSlot } from "./lkg-slot";
import type { MessageLike } from "./transform-operations";
import { isSyntheticHeadMessage } from "./transform-postprocess-phase";

/**
 * The m[0] body of the last output the module served for this session.
 *
 * In Rust mode the module composes m[0]; the host never renders one. A host that
 * asks Magic Context to summarize a session therefore has to be answered with
 * the module's own baseline, because answering with a freshly composed
 * TypeScript baseline would give the same session two different histories — one
 * in the checkpoint the host stores, another in the bytes the module keeps
 * serving.
 *
 * The bytes come from the replay slot, which holds the exact prefix of the last
 * accepted module output. Its first entry is m[0]: an id-less user message whose
 * parts are all synthetic. Anything else means the slot does not hold a module
 * head — an empty slot, a slot captured before the module ever served, or a
 * shape this function does not recognise — and the caller is told so rather than
 * handed a guess.
 */
export function servedModuleM0Text(
    sessionId: string,
    readSlot: typeof getSlot = getSlot,
): string | null {
    const slot = readSlot(sessionId);
    if (!slot) return null;
    let prefix: unknown;
    try {
        prefix = JSON.parse(slot.jsonPrefix);
    } catch {
        return null;
    }
    if (!Array.isArray(prefix) || prefix.length === 0) return null;
    const head = prefix[0] as MessageLike | undefined;
    if (!head || typeof head !== "object" || !head.info || !Array.isArray(head.parts)) return null;
    if (!isSyntheticHeadMessage(head)) return null;
    // m[0] carries its body in the first text part; a mural image, when one is
    // rendered, follows it in the same message.
    const text = head.parts.find((part) => (part as { type?: unknown }).type === "text") as
        | { text?: unknown }
        | undefined;
    return typeof text?.text === "string" ? text.text : null;
}
