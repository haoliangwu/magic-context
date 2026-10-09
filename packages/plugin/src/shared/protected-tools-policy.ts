/** Default result keep counts shared by runtime and configuration; this database-free module is bundled with the TUI. */
export const DEFAULT_PROTECTED_TOOLS: Readonly<Record<string, number>> = {
    todowrite: 1,
    ctx_reduce: 3,
};

export function normalizeProtectedToolName(name: string | null): string {
    return (name ?? "").toLowerCase().replace(/^mcp_/, "");
}

/** Normalize before merging tiers so aliases cannot defeat a project override. */
export function mergeProtectedTools(
    ...maps: (Readonly<Record<string, number>> | undefined)[]
): Record<string, number> {
    return Object.fromEntries(
        [DEFAULT_PROTECTED_TOOLS, ...maps].flatMap((map) =>
            Object.entries(map ?? {}).map(([name, count]) => [
                normalizeProtectedToolName(name),
                count,
            ]),
        ),
    );
}
