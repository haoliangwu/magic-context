export const CTX_REDUCE_DESCRIPTION = `Stamp an item on your desk as no longer needed for the work ahead. Not a delete: stamping QUEUES it, the item stays fully readable until Magic Context clears stamped items in one sweep, and the newest tags are protected so stamping recent output is harmless. A cleared item goes to the archive — a recent one leaves a \`[dropped §N§]\` placeholder, an older one leaves nothing — and \`ctx_expand(tag=N)\` is the way back. So the question before stamping is not "have I finished reading this?" but "does this need to stay on my desk for what comes next?" — a file you read and will keep editing stays; the grep that found it goes.

Stamp: file reads, search results and tool outputs the work ahead no longer needs; build/test output after you acted on it; repeated or redundant dumps; data written to disk; status/log output that only confirmed what you expected; a large block pasted inside a user message once you have used it.
Keep: user messages (never stamp one for its directive), your own conversation text, unresolved errors, raw evidence you haven't extracted yet, and outputs whose exact wording may still matter.

Look at each tag before stamping it; never blanket-stamp a range like "1-50". Many small targeted stamps beat one sweep. \`drop\` accepts "3-5", "1,2,9", "1-5,8,12-15".`;

export const CTX_REDUCE_SELF_STAMP_MESSAGE_TEMPLATE =
    "§N§ is a ctx_reduce call; leave those alone, they are cleaned up automatically.";

export function ctxReduceSelfStampMessage(tagNumber: number): string {
    return CTX_REDUCE_SELF_STAMP_MESSAGE_TEMPLATE.replace("§N§", `§${tagNumber}§`);
}
