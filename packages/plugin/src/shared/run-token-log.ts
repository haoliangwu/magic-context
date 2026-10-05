export interface RunTokenLog {
    input: number | null;
    output: number | null;
    reasoning: number | null;
    cache_read: number | null;
    cache_write: number | null;
    max_tokens: number | null;
    finish_reason: string | null;
}

function count(value: unknown): number | null {
    return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Keep provider omissions distinct from measured zero in diagnostic logs. */
export function runTokenLog(tokens: unknown, maxTokens?: number, finish?: unknown): RunTokenLog {
    const usage = tokens && typeof tokens === "object" ? (tokens as Record<string, unknown>) : {};
    const cache =
        usage.cache && typeof usage.cache === "object"
            ? (usage.cache as Record<string, unknown>)
            : {};
    return {
        input: count(usage.input ?? usage.input_tokens),
        output: count(usage.output ?? usage.output_tokens),
        reasoning: count(usage.reasoning ?? usage.reasoning_tokens),
        cache_read: count(
            usage.cacheRead ?? usage.cache_read ?? usage.cached_input_tokens ?? cache.read,
        ),
        cache_write: count(
            usage.cacheWrite ?? usage.cache_write ?? usage.cache_write_tokens ?? cache.write,
        ),
        max_tokens: count(maxTokens),
        finish_reason: typeof finish === "string" ? finish : null,
    };
}

export function formatRunTokenLog(tokens: RunTokenLog): string {
    return `tokens=${JSON.stringify(tokens)}`;
}
