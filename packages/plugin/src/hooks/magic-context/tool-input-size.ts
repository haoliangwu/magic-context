/**
 * Size rule for a dropped tool call inside the newest-call window.
 *
 * A dropped call's arguments are either served exactly as the host gave them
 * or the whole call is removed. Every synthetic value ever placed in the
 * argument position (5-character clamps ending in `...[truncated]`, then the
 * `{"dropped": "[dropped §N§]"}` marker) was copied back by models into new
 * calls, which either ran with garbage arguments or looped on the refusal.
 * Small inputs therefore keep their real arguments; large ones are removed.
 *
 * The size is the total UTF-8 byte length of every string value, recursively
 * through objects and arrays. Keys, numbers, booleans and nulls do not count.
 * It is defined on string leaves so the OpenCode, Pi and Rust lanes compute the
 * same number from the same input regardless of how each serializes JSON; the
 * shared fixture `tests/fixtures/tool-input-string-bytes.json` pins it.
 */
export const SKELETON_REAL_INPUT_MAX_BYTES = 1024;

const encoder = new TextEncoder();

export function toolInputStringBytes(value: unknown): number {
    const seen = new WeakSet<object>();
    const visit = (candidate: unknown): number => {
        if (typeof candidate === "string") return encoder.encode(candidate).length;
        if (candidate === null || typeof candidate !== "object") return 0;
        if (seen.has(candidate)) return 0;
        seen.add(candidate);
        let total = 0;
        const values = Array.isArray(candidate)
            ? candidate
            : Object.values(candidate as Record<string, unknown>);
        for (const item of values) total += visit(item);
        return total;
    };
    return visit(value);
}

/** True when a dropped call with this input keeps its real arguments. */
export function isSmallToolInput(value: unknown): boolean {
    return toolInputStringBytes(value) <= SKELETON_REAL_INPUT_MAX_BYTES;
}
