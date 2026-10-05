/** Bound plain read output for mapper/verify children so one large file cannot dominate their tool loop. */
export const DREAMER_READ_MAX_CHARS = 8_000;

export function capDreamerReadOutput(input: unknown, output: unknown): boolean {
    const call = input as { tool?: string; agent?: string };
    const result = output as { output?: string } | undefined;
    if (
        call.tool !== "read" ||
        call.agent !== "dreamer-memory-mapper" ||
        typeof result?.output !== "string" ||
        result.output.length <= DREAMER_READ_MAX_CHARS
    )
        return false;
    result.output = `${result.output.slice(0, DREAMER_READ_MAX_CHARS)}\n[Read capped at ${DREAMER_READ_MAX_CHARS} characters. Use offset/limit to request the relevant line range.]`;
    return true;
}
