import { USER_FACING_FAILURES } from "../../shared/user-facing-codes";

export const SINGLE_STORE_MIGRATION_REQUIRED_CODE = "single_store_migration_required";

export function renderSingleStoreMigrationRequiredRefusal(): string {
    const failure = USER_FACING_FAILURES.single_store_migration_required;
    return `${failure.sentence} ${failure.action} (${failure.code})`;
}

/** A store refusal is terminal for the turn, not a transport outage to replay around. */
export class SingleStoreMigrationRequiredError extends Error {
    readonly code = SINGLE_STORE_MIGRATION_REQUIRED_CODE;

    constructor(options?: { cause?: unknown }) {
        super(renderSingleStoreMigrationRequiredRefusal(), options);
        this.name = "SingleStoreMigrationRequiredError";
    }
}

/** Match wire codes across bundled clients and wrappers without relying on their error classes. */
export function singleStoreMigrationRequiredFailure(
    error: unknown,
): SingleStoreMigrationRequiredError | null {
    let current = error;
    const seen = new Set<unknown>();
    while (current !== null && typeof current === "object" && !seen.has(current)) {
        seen.add(current);
        if (current instanceof SingleStoreMigrationRequiredError) return current;
        const frame = current as { code?: unknown; cause?: unknown };
        if (
            frame.code === SINGLE_STORE_MIGRATION_REQUIRED_CODE ||
            frame.code === "single_store_state_split"
        ) {
            return new SingleStoreMigrationRequiredError({ cause: error });
        }
        current = frame.cause;
    }
    return null;
}

/** Old authority triggers still protect unmigrated projects until the offline copy clears them. */
export function projectNeedsSingleStoreMigration(
    db: import("../../shared/sqlite").Database,
    projectPath: string,
): boolean {
    const table = db
        .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'authority_managed'")
        .get();
    return Boolean(
        table &&
            db.prepare("SELECT 1 FROM authority_managed WHERE project_path = ?").get(projectPath),
    );
}
