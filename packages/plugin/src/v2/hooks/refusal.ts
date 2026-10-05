import type { V2Context } from "./types";

export class V2ContextRefusal extends Error {
    constructor(
        message = "Context full — /ctx-flush or /clear to continue.",
        options?: ErrorOptions,
    ) {
        super(message, options);
        this.name = "V2ContextRefusal";
    }
}

/** How long the host gets to confirm an interrupt before the turn is refused anyway. */
export const INTERRUPT_CONFIRMATION_TIMEOUT_MS = 2000;

/** Timer functions the interrupt deadline uses. Tests pass a manual clock so the
 * deadline fires when the test says so, not when a busy event loop gets to it. */
export interface InterruptTimers {
    setTimeout(callback: () => void, ms: number): unknown;
    clearTimeout(handle: unknown): void;
}

const systemTimers: InterruptTimers = {
    setTimeout: (callback, ms) => setTimeout(callback, ms),
    clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** An idle no-op is not confirmation that the pending provider request was cancelled. */
export async function interruptBeforeProvider(
    session: Pick<V2Context["session"], "interrupt">,
    sessionID: Parameters<V2Context["session"]["interrupt"]>[0]["sessionID"],
    timers: InterruptTimers = systemTimers,
): Promise<void> {
    let timer: unknown;
    try {
        const result = await Promise.race([
            session.interrupt({ sessionID }),
            new Promise<never>((_, reject) => {
                timer = timers.setTimeout(
                    () =>
                        reject(
                            new Error(`interrupt exceeded ${INTERRUPT_CONFIRMATION_TIMEOUT_MS} ms`),
                        ),
                    INTERRUPT_CONFIRMATION_TIMEOUT_MS,
                );
            }),
        ]);
        if (result.interrupted !== true)
            throw new Error("interrupt arrived after the turn became idle");
    } catch (cause) {
        throw new V2ContextRefusal(undefined, { cause });
    } finally {
        if (timer !== undefined) timers.clearTimeout(timer);
    }
}
