import { type Database, withSqliteBackgroundWriter } from "../../../shared/sqlite";
import { logSlowWriteTransaction } from "../../../shared/write-transaction-timing";
import { deleteDreamState, getDreamState, setDreamState } from "./storage-dream-state";

const LEASE_DURATION_MS = 2 * 60 * 1000; // Expires after 2 minutes unless the heartbeat renews it.

/**
 * Each lease key identifies an independent conflict domain (memory:<project>,
 * key-files:<project>, user-memories, …). Different keys can be used at the same
 * time, while work using the same key is serialized. Each lease is represented by
 * four `dream_state` rows under its key namespace.
 *
 * `DREAMING_LEASE_KEY` is the legacy default key. Keeping it as the default
 * preserves callers that still use `acquireLease(db, holderId)` without a key.
 */
export const DREAMING_LEASE_KEY = "dreaming";

interface LeaseRowKeys {
    holder: string;
    heartbeat: string;
    expiry: string;
    generation: string;
}

function rowKeys(leaseKey: string): LeaseRowKeys {
    // Preserve the legacy row names so leases created by an older plugin version
    // remain readable during an upgrade.
    if (leaseKey === DREAMING_LEASE_KEY) {
        return {
            holder: "dreaming_lease_holder",
            heartbeat: "dreaming_lease_heartbeat",
            expiry: "dreaming_lease_expiry",
            generation: "dreaming_lease_generation",
        };
    }
    return {
        holder: `lease:${leaseKey}:holder`,
        heartbeat: `lease:${leaseKey}:heartbeat`,
        expiry: `lease:${leaseKey}:expiry`,
        generation: `lease:${leaseKey}:generation`,
    };
}

function getLeaseExpiry(db: Database, keys: LeaseRowKeys): number | null {
    const value = getDreamState(db, keys.expiry);
    if (!value) {
        return null;
    }

    const expiry = Number(value);
    return Number.isFinite(expiry) ? expiry : null;
}

export function isLeaseActive(db: Database, leaseKey: string = DREAMING_LEASE_KEY): boolean {
    const expiry = getLeaseExpiry(db, rowKeys(leaseKey));
    return expiry !== null && expiry > Date.now();
}

export function getLeaseHolder(db: Database, leaseKey: string = DREAMING_LEASE_KEY): string | null {
    return getDreamState(db, rowKeys(leaseKey).holder);
}

export function getLeaseGeneration(
    db: Database,
    leaseKey: string = DREAMING_LEASE_KEY,
): number | null {
    const value = getDreamState(db, rowKeys(leaseKey).generation);
    if (!value) return null;
    const generation = Number(value);
    return Number.isSafeInteger(generation) && generation > 0 ? generation : null;
}

export function peekLeaseHolderAndExpiry(
    db: Database,
    expectedHolder: string,
    leaseKey: string = DREAMING_LEASE_KEY,
): boolean {
    const keys = rowKeys(leaseKey);
    const holder = getDreamState(db, keys.holder);
    if (holder !== expectedHolder) return false;
    const expiryStr = getDreamState(db, keys.expiry);
    if (!expiryStr) return false;
    const expiry = Number(expiryStr);
    return Number.isFinite(expiry) && expiry >= Date.now();
}

export function leaseOwnershipMatches(
    db: Database,
    expectedHolder: string,
    expectedGeneration: number,
    leaseKey: string = DREAMING_LEASE_KEY,
): boolean {
    return (
        getLeaseGeneration(db, leaseKey) === expectedGeneration &&
        peekLeaseHolderAndExpiry(db, expectedHolder, leaseKey)
    );
}

// Mutations that update a lease use BEGIN IMMEDIATE. SQLite takes the write lock
// before code reads and updates the four lease rows, making each decision atomic
// across handles sharing the database and preventing duplicate acquisition.
// busy_timeout (set in initializeDatabase) makes a contending process wait rather
// than fail immediately with SQLITE_BUSY.
function runImmediate<T>(
    db: Database,
    body: () => T,
    site?: string,
    slowWriteThresholdMs?: number,
): T {
    db.exec("BEGIN IMMEDIATE");
    const transactionStartedAt = site === undefined ? undefined : performance.now();
    let committed = false;
    try {
        const result = body();
        db.exec("COMMIT");
        committed = true;
        if (site !== undefined && transactionStartedAt !== undefined) {
            logSlowWriteTransaction(site, transactionStartedAt, slowWriteThresholdMs);
        }
        return result;
    } finally {
        if (!committed) {
            try {
                db.exec("ROLLBACK");
            } catch {
                // already rolled back / no active transaction
            }
        }
    }
}

export interface LeaseAcquisition {
    acquiredAt: number;
    generation: number;
}

export function acquireLeaseWithAcquisition(
    db: Database,
    holderId: string,
    leaseKey: string = DREAMING_LEASE_KEY,
): LeaseAcquisition | null {
    const keys = rowKeys(leaseKey);
    return runImmediate(db, () => {
        const existingHolder = getLeaseHolder(db, leaseKey);
        if (isLeaseActive(db, leaseKey) && existingHolder && existingHolder !== holderId) {
            return null;
        }

        const now = Date.now();
        const priorGeneration = getLeaseGeneration(db, leaseKey) ?? 0;
        const generation =
            existingHolder === holderId ? Math.max(1, priorGeneration) : priorGeneration + 1;
        setDreamState(db, keys.holder, holderId);
        setDreamState(db, keys.heartbeat, String(now));
        setDreamState(db, keys.expiry, String(now + LEASE_DURATION_MS));
        setDreamState(db, keys.generation, String(generation));
        return { acquiredAt: now, generation };
    });
}

export function acquireLease(
    db: Database,
    holderId: string,
    leaseKey: string = DREAMING_LEASE_KEY,
): boolean {
    return acquireLeaseWithAcquisition(db, holderId, leaseKey) !== null;
}

export function renewLease(
    db: Database,
    holderId: string,
    leaseKey: string = DREAMING_LEASE_KEY,
    expectedGeneration?: number,
): boolean {
    const keys = rowKeys(leaseKey);
    return runImmediate(db, () => {
        if (
            getLeaseHolder(db, leaseKey) !== holderId ||
            !isLeaseActive(db, leaseKey) ||
            (expectedGeneration !== undefined &&
                getLeaseGeneration(db, leaseKey) !== expectedGeneration)
        ) {
            return false;
        }

        const now = Date.now();
        setDreamState(db, keys.heartbeat, String(now));
        setDreamState(db, keys.expiry, String(now + LEASE_DURATION_MS));
        return true;
    });
}

export function runLeaseGuardedWrite<T>(
    db: Database,
    holderId: string,
    leaseKey: string,
    fn: () => T,
    slowWriteThresholdMs?: number,
): T {
    return runImmediate(
        db,
        () => {
            // Check ownership after BEGIN IMMEDIATE acquires the write lock. This
            // prevents another process from taking the lease before fn performs its
            // write.
            if (!peekLeaseHolderAndExpiry(db, holderId, leaseKey)) {
                throw new Error("Dream lease lost before guarded write");
            }
            return fn();
        },
        `lease-guarded-write:${leaseKey}`,
        slowWriteThresholdMs,
    );
}

/** Three beats per lease leave room for one contended or delayed renewal. */
const LEASE_HEARTBEAT_INTERVAL_MS = 40 * 1000;

/** Atomically refresh an expired lease only if its original holder and generation remain. */
export function reacquireOwnedLease(
    db: Database,
    holderId: string,
    leaseKey: string,
    generation: number,
): boolean {
    const keys = rowKeys(leaseKey);
    return runImmediate(db, () => {
        if (
            getLeaseHolder(db, leaseKey) !== holderId ||
            getLeaseGeneration(db, leaseKey) !== generation
        ) {
            return false;
        }
        const now = Date.now();
        setDreamState(db, keys.heartbeat, String(now));
        setDreamState(db, keys.expiry, String(now + LEASE_DURATION_MS));
        return true;
    });
}

export interface LeaseHeartbeat {
    /** Stop the heartbeat timer. Safe to call more than once. */
    stop(): void;
    /** True after this process no longer owns the lease and onLost was called. */
    readonly lost: boolean;
    /** Number of transient renewal/reacquisition errors observed by this heartbeat. */
    readonly renewalFailures: number;
}

/**
 * Keep a held lease alive on a background interval. Transient renewal errors are
 * retried, an expired lease is reacquired when no other holder claimed it, and
 * lease loss is reported once when ownership or generation no longer matches.
 */
export function startLeaseHeartbeat(
    db: Database,
    holderId: string,
    leaseKey: string,
    onLost: (reason: string) => void,
    intervalOrAcquisition: number | LeaseAcquisition = LEASE_HEARTBEAT_INTERVAL_MS,
): LeaseHeartbeat {
    const intervalMs =
        typeof intervalOrAcquisition === "number"
            ? intervalOrAcquisition
            : LEASE_HEARTBEAT_INTERVAL_MS;
    const acquisition =
        typeof intervalOrAcquisition === "number" ? undefined : intervalOrAcquisition;
    let lost = false;
    const expectedGeneration = acquisition?.generation ?? getLeaseGeneration(db, leaseKey);
    let renewalFailures = 0;
    const declareLost = (reason: string): void => {
        if (lost) return;
        lost = true;
        onLost(reason);
    };
    const beat = () => {
        if (lost) return;
        try {
            // A successful renewal confirms that this process still owns the lease.
            if (
                renewLease(
                    db,
                    holderId,
                    leaseKey,
                    expectedGeneration === null ? undefined : expectedGeneration,
                )
            ) {
                return;
            }
            // The write lock protects this check and refresh from a concurrent
            // acquirer; an expired timestamp alone is not evidence of takeover.
            if (
                expectedGeneration !== null &&
                reacquireOwnedLease(db, holderId, leaseKey, expectedGeneration)
            )
                return;
            const holder = getLeaseHolder(db, leaseKey);
            if (holder !== null && holder !== holderId) {
                declareLost(`lease_lost: taken by ${holder}`);
            } else if (getLeaseGeneration(db, leaseKey) !== expectedGeneration) {
                declareLost("lease_lost: generation changed");
            } else {
                declareLost("lease_expired: reacquire failed (holder missing)");
            }
        } catch {
            // SQLITE_BUSY and other transient database errors do not establish
            // takeover. Retry at the next beat and retain the failure count.
            renewalFailures += 1;
        }
    };

    // Confirm ownership synchronously before returning. Otherwise the caller could
    // pause until the lease expires and begin work after another task acquires the
    // same lease key.
    beat();

    const timer = lost
        ? undefined
        : setInterval(() => withSqliteBackgroundWriter(beat), intervalMs);
    return {
        stop: () => {
            if (timer) clearInterval(timer);
        },
        get lost() {
            return lost;
        },
        get renewalFailures() {
            return renewalFailures;
        },
    };
}

export function releaseLease(
    db: Database,
    holderId: string,
    leaseKey: string = DREAMING_LEASE_KEY,
): void {
    const keys = rowKeys(leaseKey);
    runImmediate(db, () => {
        if (getLeaseHolder(db, leaseKey) !== holderId) {
            return;
        }

        deleteDreamState(db, keys.holder);
        deleteDreamState(db, keys.heartbeat);
        deleteDreamState(db, keys.expiry);
    });
}
