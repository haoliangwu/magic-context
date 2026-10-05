/**
 * Load the shared SQLite selector before importing doctor implementations.
 *
 * The selector uses top-level dynamic import so plugin startup still fails fast
 * when neither supported backend exists. The CLI must probe it separately:
 * otherwise importing a doctor module would throw before doctor can print the
 * compatibility diagnosis.
 */
export type SqliteProbe = () => Promise<unknown>;

export async function probeSqliteBackend(): Promise<void> {
    // Keep this specifier literal so the published single-file CLI bundle
    // includes the selector instead of leaving an unresolved package import.
    await import("@magic-context/core/shared/sqlite");
}

export function formatSqlitePreflightFailure(error: unknown): string {
    const detail = error instanceof Error ? error.message : String(error ?? "Unknown error");
    return [
        "Magic Context doctor cannot use SQLite in this runtime.",
        `SQLite probe: ${detail}`,
        "Remediation: install Node.js 22.16+ (22.x) or >= 24, or use a Bun build with node:sqlite.",
        "For Docker, use node:24-slim or a two-runtime image.",
    ].join("\n");
}

export async function runSqlitePreflight(
    probe: SqliteProbe = probeSqliteBackend,
    report: (message: string) => void = (message) => console.error(message),
): Promise<boolean> {
    try {
        await probe();
        return true;
    } catch (error) {
        report(formatSqlitePreflightFailure(error));
        return false;
    }
}
