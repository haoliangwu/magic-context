/**
 * Mode selection for ctx_expand when a required-all tool surface fills every
 * declared property with a schema-valid placeholder (`0`, `false`).
 *
 * A named range wins over `message`, so a range call that also carries
 * `message=0` still expands the range. The pair `start=end=0` is that numeric
 * filler, not a named range, so a message call that also carries `start=0`,
 * `end=0` still recovers the message. A lone `{start:0,end:0}` on the
 * non-negative (Claude Code) domain stays a real one-message range: `0` is a
 * valid ordinal there, and no message field is competing.
 */

export type CtxExpandOrdinalDomain = "positive" | "non-negative";

export type CtxExpandMode =
    | { kind: "message"; message: number }
    | { kind: "range"; start: number; end: number; verbose: boolean }
    | { kind: "error"; message: string };

function isInt(value: unknown): value is number {
    return typeof value === "number" && Number.isInteger(value);
}

function minOrdinal(domain: CtxExpandOrdinalDomain): number {
    return domain === "non-negative" ? 0 : 1;
}

function messageError(domain: CtxExpandOrdinalDomain): string {
    return domain === "non-negative"
        ? "Error: message must be a non-negative integer."
        : "Error: message must be a positive integer.";
}

function rangeError(domain: CtxExpandOrdinalDomain): string {
    return domain === "non-negative"
        ? "Error: provide either message=<ordinal>, or start and end (non-negative integers, start <= end)."
        : "Error: provide either message=<ordinal>, or start and end (positive integers, start <= end).";
}

export function resolveCtxExpandMode(
    args: {
        start?: unknown;
        end?: unknown;
        message?: unknown;
        verbose?: unknown;
    },
    domain: CtxExpandOrdinalDomain,
): CtxExpandMode {
    const min = minOrdinal(domain);
    const messagePresent = args.message !== undefined && args.message !== null;
    const message = isInt(args.message) ? args.message : undefined;
    const start = isInt(args.start) ? args.start : undefined;
    const end = isInt(args.end) ? args.end : undefined;
    const messageValid = message !== undefined && message >= min;
    const rangeValid = start !== undefined && end !== undefined && start >= min && end >= start;
    const fillerPair = start === 0 && end === 0;
    const rangeNamed = rangeValid && !fillerPair;

    if (messageValid && !rangeNamed) {
        return { kind: "message", message };
    }
    if (messagePresent && !messageValid && !rangeNamed) {
        return { kind: "error", message: messageError(domain) };
    }
    if (rangeValid) {
        return {
            kind: "range",
            start,
            end,
            verbose: args.verbose === true,
        };
    }
    return { kind: "error", message: rangeError(domain) };
}
