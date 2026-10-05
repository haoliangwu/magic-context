/**
 * Host rows that keep a raw-message ordinal but never reach the provider under
 * their own message id.
 *
 * OpenCode 2 stores instruction updates ("Today's date is now: ...", changed
 * AGENTS.md files) as `system` rows in `session_message`. They are part of the
 * raw-message ordinal space, yet the host renders them into the request draft as
 * an id-less system message. A compartment that ends on such a row names a
 * boundary no request ever contains, so every trim that looks the boundary up by
 * id fails and injection falls back to serving the whole history raw.
 *
 * The rule, matching the Pi adapter's handling of transcript system entries:
 * ordinals stay continuous, but such a row is never a compartment boundary. A
 * boundary always lands on a row the host serves with its id; an unserved row at
 * the edge of a compartment stays in the raw tail instead.
 *
 * Only the OpenCode 2 store projection marks rows. The flag is a non-enumerable
 * property so v1 and Pi objects, their JSON fixtures and golden outputs are
 * unchanged.
 */

const HOST_UNSERVED_ROW = "hostUnservedRow";

/** Mark a raw message (or a chunk line derived from one) as a row the host never serves by id. */
export function markHostUnservedRow<T extends object>(target: T): T {
    Object.defineProperty(target, HOST_UNSERVED_ROW, {
        value: true,
        enumerable: false,
        configurable: true,
    });
    return target;
}

export function isHostUnservedRow(value: unknown): boolean {
    return (
        typeof value === "object" &&
        value !== null &&
        (value as Record<string, unknown>)[HOST_UNSERVED_ROW] === true
    );
}

/**
 * Move an exclusive end ordinal back so the last included ordinal is a row the
 * host serves. `floor` is the smallest ordinal the range may still include; the
 * result never drops below it, so an all-unserved range becomes empty rather
 * than reaching into history that is already summarized.
 */
export function retreatPastHostUnservedRows(
    messages: ReadonlyArray<{ ordinal: number }>,
    exclusiveEnd: number,
    floor: number,
): number {
    if (!messages.some(isHostUnservedRow)) return exclusiveEnd;
    const byOrdinal = new Map(messages.map((message) => [message.ordinal, message]));
    let end = exclusiveEnd;
    while (end - 1 >= floor && isHostUnservedRow(byOrdinal.get(end - 1))) end -= 1;
    return end;
}

/**
 * Pull the final compartment's end back onto the nearest row the host serves.
 * Only the final compartment defines the boundary a request is trimmed at; an
 * earlier compartment's end is followed by the next compartment's start, so
 * moving it would open a gap. A final compartment made only of unserved rows is
 * dropped: those rows stay raw and the next historian run covers them.
 */
export function snapTerminalCompartmentToServedRow<
    T extends { startMessage: number; endMessage: number; endMessageId: string },
>(
    compartments: readonly T[],
    lines: ReadonlyArray<{ ordinal: number; messageId: string }>,
): { compartments: T[]; snapped: boolean } {
    if (!lines.some(isHostUnservedRow)) return { compartments: [...compartments], snapped: false };
    const byOrdinal = new Map(lines.map((line) => [line.ordinal, line]));
    const result = [...compartments];
    let snapped = false;
    while (result.length > 0) {
        const last = result[result.length - 1];
        if (!isHostUnservedRow(byOrdinal.get(last.endMessage))) break;
        snapped = true;
        let served: { ordinal: number; messageId: string } | undefined;
        for (let ordinal = last.endMessage - 1; ordinal >= last.startMessage; ordinal -= 1) {
            const line = byOrdinal.get(ordinal);
            if (line && !isHostUnservedRow(line)) {
                served = line;
                break;
            }
        }
        if (!served) {
            result.pop();
            continue;
        }
        result[result.length - 1] = {
            ...last,
            endMessage: served.ordinal,
            endMessageId: served.messageId,
        };
        break;
    }
    return { compartments: result, snapped };
}

/** An id-less system message is the host's rendering of an unserved instruction row. */
export function isHostRenderedSystemMessage(message: {
    info: { id?: unknown; role?: unknown };
}): boolean {
    const id = message.info.id;
    return (typeof id !== "string" || id.length === 0) && message.info.role === "system";
}
