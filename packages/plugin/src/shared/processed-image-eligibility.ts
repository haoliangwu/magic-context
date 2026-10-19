/**
 * Shared processed-image age and recency policy for both OpenCode adapters.
 * Use the owning message's positive maximum tag; an untagged image-only message
 * inherits the next positive tagged message after it, never age zero or a tag
 * from an earlier message. Without either tag, retain the image at the live tail.
 * A positive dropped-tag watermark must cover that position. Below 95% usage,
 * retain every position at or beyond the protected newest-window cutoff. At
 * 95% and above only that window yields, exactly as for emergency tool drops;
 * independent per-tool protections still apply. Content before retained provider-signed
 * thinking must stay unchanged unless an existing whole-turn rewrite removes that
 * thinking first. Callers enforce these protections, later-assistant/stable-id checks, durable
 * persistence and rewrite-only discovery. Frozen replay bypasses eligibility.
 */
export function createProcessedImageEligibility<T>(
    messages: readonly T[],
    messageTagNumbers: ReadonlyMap<T, number>,
    options: { watermark: number; protectedCutoff?: number | null; contextPercentage?: number },
): { ageTags: ReadonlyMap<T, number>; mayStrip: (message: T) => boolean } {
    const ageTags = new Map<T, number>();
    let nextTag: number | undefined;
    for (let index = messages.length - 1; index >= 0; index--) {
        const message = messages[index];
        const ownTag = messageTagNumbers.get(message);
        if (ownTag !== undefined && Number.isFinite(ownTag) && ownTag > 0) nextTag = ownTag;
        if (nextTag !== undefined) ageTags.set(message, nextTag);
    }
    return {
        ageTags,
        mayStrip: (message) => {
            const age = ageTags.get(message);
            return (
                options.watermark > 0 &&
                age !== undefined &&
                age <= options.watermark &&
                ((options.contextPercentage ?? 0) >= 95 ||
                    options.protectedCutoff == null ||
                    age < options.protectedCutoff)
            );
        },
    };
}
