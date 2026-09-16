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

/** An idle no-op is not confirmation that the pending provider request was cancelled. */
export async function interruptBeforeProvider(
    session: Pick<V2Context["session"], "interrupt">,
    sessionID: Parameters<V2Context["session"]["interrupt"]>[0]["sessionID"],
): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        const result = await Promise.race([
            session.interrupt({ sessionID }),
            new Promise<never>((_, reject) => {
                timer = setTimeout(() => reject(new Error("interrupt exceeded 2000 ms")), 2000);
            }),
        ]);
        if (result.interrupted !== true)
            throw new Error("interrupt arrived after the turn became idle");
    } catch (cause) {
        throw new V2ContextRefusal(undefined, { cause });
    } finally {
        clearTimeout(timer);
    }
}
