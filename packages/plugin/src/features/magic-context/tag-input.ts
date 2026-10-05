export const TAG_INPUT_ERROR =
    'Error: tag must be one positive integer: 12, "12", "§12§", "§12", "tag 12", or "[dropped §12§]" (surrounding whitespace is allowed).';

/** Normalize copied transcript handles without accepting embedded or multiple numbers. */
export function parseTagInput(value: unknown): number {
    if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return value;
    if (typeof value === "string") {
        const text = value.trim();
        const match = /^(?:([0-9]+)|§([0-9]+)§?|tag\s+([0-9]+)|\[dropped\s+§([0-9]+)§\])$/.exec(
            text,
        );
        const number = match ? Number(match.slice(1).find((part) => part !== undefined)) : NaN;
        if (Number.isSafeInteger(number) && number > 0) return number;
    }
    throw new Error(TAG_INPUT_ERROR);
}
