import { USER_FACING_FAILURES } from "../../shared/user-facing-codes";

/**
 * The error code ck-mc answers every request with when the `store.db` it was started on records
 * a schema version newer than any migration the binary carries. That happens when a newer ck-mc
 * migrated the store and only the binary was rolled back.
 */
export const STORE_AHEAD_OF_BINARY_CODE = "store_ahead_of_binary";

export interface StoreAheadVersions {
    /** The highest migration version recorded in `store.db`. */
    dbVersion: number;
    /** The highest migration version the running ck-mc carries. */
    binaryMax: number;
}

/**
 * The sentence a user reads when the module refuses a store that is ahead of it. It mirrors the
 * module's own facade message, so a refused turn and a refused tool call say the same thing.
 * The versions are named when the module sent them; the advice is the same either way.
 */
export function renderStoreAheadOfBinaryRefusal(versions: StoreAheadVersions | null): string {
    const failure = USER_FACING_FAILURES.store_ahead_of_binary;
    const sentence = versions
        ? `Magic Context refused to start: its store (store.db) is at schema v${versions.dbVersion} but this ck-mc build only knows up to v${versions.binaryMax}.`
        : failure.sentence;
    return `${sentence} ${failure.action} (${failure.code})`;
}

/**
 * The module refused to serve because its store is ahead of it.
 *
 * Deliberately not retryable and not a candidate for last-known-good replay: the module cannot
 * serve this store until someone updates ck-mc or restores both databases, so replaying an old
 * answer would hide a refusal that no retry will clear.
 */
export class StoreAheadOfBinaryError extends Error {
    readonly code = STORE_AHEAD_OF_BINARY_CODE;
    readonly versions: StoreAheadVersions | null;

    constructor(versions: StoreAheadVersions | null, options?: { cause?: unknown }) {
        super(renderStoreAheadOfBinaryRefusal(versions), options);
        this.name = "StoreAheadOfBinaryError";
        this.versions = versions;
    }
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === "object";
}

function nonNegativeInteger(value: unknown): number | null {
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function versionsFromDetail(detail: unknown): StoreAheadVersions | null {
    if (!isRecord(detail)) return null;
    const dbVersion = nonNegativeInteger(detail.db_version);
    const binaryMax = nonNegativeInteger(detail.binary_max);
    return dbVersion !== null && binaryMax !== null ? { dbVersion, binaryMax } : null;
}

/**
 * Read both versions from the module's message when the transport dropped the structured
 * detail. The operator message carries `db_version=N binary_max=M`; the facade message carries
 * the user sentence rendered above.
 */
function versionsFromMessage(message: unknown): StoreAheadVersions | null {
    if (typeof message !== "string") return null;
    const match =
        /db_version=(\d+) binary_max=(\d+)/.exec(message) ??
        /schema v(\d+) but this ck-mc build only knows up to v(\d+)/.exec(message);
    if (!match) return null;
    return { dbVersion: Number(match[1]), binaryMax: Number(match[2]) };
}

/**
 * The store-ahead refusal carried anywhere in an error's cause chain, or `null`.
 *
 * The code is matched by its wire value rather than by error class, because the subc client that
 * produced the error can be a different bundled copy from the one this plugin imports.
 */
export function storeAheadOfBinaryFailure(error: unknown): StoreAheadOfBinaryError | null {
    let current = error;
    const seen = new Set<unknown>();
    while (isRecord(current) && !seen.has(current)) {
        seen.add(current);
        if (current instanceof StoreAheadOfBinaryError) return current;
        if (current.code === STORE_AHEAD_OF_BINARY_CODE) {
            const versions =
                versionsFromDetail(current.detail) ?? versionsFromMessage(current.message);
            return new StoreAheadOfBinaryError(versions, { cause: error });
        }
        current = current.cause;
    }
    return null;
}
