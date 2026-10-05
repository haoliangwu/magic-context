import { log } from "../../shared/logger";
import { SqliteAcquisitionBusyError } from "../../shared/sqlite";

export const STORAGE_BUSY_MESSAGE =
    "Magic Context's database is busy (another process held it too long); send your message again.";

/**
 * Retry layers can wrap the acquisition error more than once. Describe the
 * SQLite error underneath ("database is locked") so the refusal log names the
 * real cause rather than a wrapper.
 */
export function describeStorageBusyCause(cause: unknown): string {
    let original: unknown = cause;
    for (let depth = 0; original instanceof SqliteAcquisitionBusyError && depth < 5; depth++) {
        original = original.cause;
    }
    if (!(original instanceof Error)) return String(original);
    return original.stack ? `${original.message}\n${original.stack}` : original.message;
}

export class StorageBusyRefusalError extends Error {
    readonly code = "STORAGE_BUSY_REFUSAL";
    readonly recoverable = true;
    /**
     * Where the refusal was raised. The outer wrapper reads it: `rust-mode-emergency`
     * means the Rust adapter refused while failing closed (usage at or above 95% of
     * the model's limit, or a proven provider overflow), where it serves no
     * last-known-good replay, so the wrapper must not serve one either.
     */
    readonly stage: string;
    constructor(cause: unknown, stage: string) {
        super(STORAGE_BUSY_MESSAGE, { cause });
        this.name = "StorageBusyRefusalError";
        this.stage = stage;
        const detail = describeStorageBusyCause(cause);
        log(
            `[magic-context] storage-busy refusal stage=${stage}${cause instanceof SqliteAcquisitionBusyError ? ` acquisition=${cause.stage}` : ""}: ${detail}`,
        );
    }
}
