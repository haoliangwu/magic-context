export const MERGED_REASONING_PARTS_PREFIX = "__merged_reasoning_parts_v1__:";
export type FrozenReasoningPart = string | number;

const decodedDecisions = new Map<string, [string, FrozenReasoningPart[]] | null>();
let decodedDecisionBytes = 0;
const MAX_DECODED_DECISION_BYTES = 32 * 1024 * 1024;

/** Stable host part ids are preferred; adapters without ids use the part index. */
export function decodeMergedReasoningParts(value: string): [string, FrozenReasoningPart[]] | null {
    if (!value.startsWith(MERGED_REASONING_PARTS_PREFIX)) return null;
    try {
        const record: unknown = JSON.parse(value.slice(MERGED_REASONING_PARTS_PREFIX.length));
        if (!Array.isArray(record) || record.length !== 2) return null;
        const [id, parts] = record;
        if (
            typeof id !== "string" ||
            id.length === 0 ||
            !Array.isArray(parts) ||
            parts.length === 0
        )
            return null;
        if (
            !parts.every(
                (part) =>
                    (typeof part === "string" && part.length > 0) ||
                    (typeof part === "number" && Number.isSafeInteger(part) && part >= 0),
            )
        )
            return null;
        return [id, parts];
    } catch {
        // Ignore malformed decisions; interpreting them as removal requests
        // could discard signed reasoning parts that were previously retained.
        return null;
    }
}

export function readFrozenMergedReasoningParts(
    ids: ReadonlySet<string>,
): Map<string, FrozenReasoningPart[]> {
    const decisions = new Map<string, FrozenReasoningPart[]>();
    for (const value of ids) {
        let record = decodedDecisions.get(value);
        if (record === undefined) {
            record = decodeMergedReasoningParts(value);
            const bytes = 2 * value.length + 128;
            if (bytes <= MAX_DECODED_DECISION_BYTES) {
                while (
                    decodedDecisions.size >= 100_000 ||
                    decodedDecisionBytes + bytes > MAX_DECODED_DECISION_BYTES
                ) {
                    const oldest = decodedDecisions.keys().next().value;
                    if (oldest === undefined) break;
                    decodedDecisionBytes -= 2 * oldest.length + 128;
                    decodedDecisions.delete(oldest);
                }
                decodedDecisions.set(value, record);
                decodedDecisionBytes += bytes;
            }
        }
        // Encoded strings are immutable cache keys. Never lend the cached array
        // to callers, whose pass-local edits must not alter a later replay.
        if (record && !decisions.has(record[0])) decisions.set(record[0], [...record[1]]);
    }
    return decisions;
}
