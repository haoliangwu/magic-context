/**
 * Content tag ids name the message that owns them plus a suffix that picks one
 * part of it. Two suffix families exist:
 *
 * - positional: `<messageId>:p<N>` for the Nth text part, `<messageId>:file<N>`
 *   for the Nth file part;
 * - content-derived (Pi, after the text of a message drifts):
 *   `<messageId>:mc-text-v1:<vector digest>:<content digest>:o<occurrence>`.
 *
 * Anything that groups tags by message has to strip both, or a content-derived
 * tag is treated as belonging to a message that does not exist.
 */

export const TEXT_TAG_IDENTITY_MARKER = ":mc-text-v1:";

const POSITIONAL_CONTENT_SUFFIX = /:(?:p|file)\d+$/;
const CONTENT_DERIVED_TEXT_SUFFIX = /:mc-text-v1:[0-9a-f]+:[0-9a-f]+:o\d+$/;

/**
 * The owning message id of a content tag id. An id with neither suffix is
 * returned unchanged: it already is the message id.
 */
export function contentTagOwnerMessageId(contentId: string): string {
    const positional = POSITIONAL_CONTENT_SUFFIX.exec(contentId);
    if (positional) return contentId.slice(0, positional.index);
    const derived = CONTENT_DERIVED_TEXT_SUFFIX.exec(contentId);
    if (derived) return contentId.slice(0, derived.index);
    return contentId;
}
