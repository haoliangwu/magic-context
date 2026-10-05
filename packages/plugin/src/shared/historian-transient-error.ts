/**
 * Decide whether a failed historian prompt is worth retrying on the same model.
 *
 * Provider errors arrive as free text, so this is a keyword test, but every
 * keyword must stand alone: "auth" must not match "author", and status 500
 * must not match "250000" inside "prompt is too long: 250000 tokens". A
 * misread here either retries a request that can never succeed (twice more,
 * at full cost) or gives up on a provider blip.
 *
 * Shared by the OpenCode and Pi historian runners so both classify alike.
 */
const NON_TRANSIENT_PATTERN =
    /(?<![a-z])(?:invalid[ _]request|bad[ _]request|unauthori[sz]ed|forbidden|authentication|authenticate|authorization|o?auth)(?![a-z])|(?:^| )400(?!\d)/;

const TRANSIENT_PATTERN =
    /(?<!\d)(?:429|500|502|503)(?!\d)|rate[ _]limit|timeout|econnreset|etimedout|overloaded/;

export function isTransientHistorianPromptError(message: string): boolean {
    const normalized = message.toLowerCase();
    if (NON_TRANSIENT_PATTERN.test(normalized)) return false;
    return TRANSIENT_PATTERN.test(normalized);
}
