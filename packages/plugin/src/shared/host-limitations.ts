import { USER_FACING_FAILURES, type UserFacingFailureKey } from "./user-facing-codes";

/**
 * Named things the host Magic Context is running in cannot do.
 *
 * A limitation is not a failed operation: it is a capability the current host
 * lacks for as long as this process lives, so every status surface keeps
 * printing it instead of showing it once and forgetting. Each one is an
 * existing MC-* user-facing code, so the status dialog, the plain-text status
 * summary and the sidebar all print the same sentence for it.
 *
 * Process-global on purpose. The surfaces that show these (the RPC status and
 * sidebar handlers) are built without a reference to the adapter that
 * discovered the limitation, and a limitation of the host is true for every
 * session in the process rather than for one of them.
 */
const declared = new Set<UserFacingFailureKey>();

/**
 * Record a limitation of this host. Returns true only the first time a given
 * limitation is declared, which is what callers use to log their explanation
 * once instead of on every pass.
 */
export function declareHostLimitation(key: UserFacingFailureKey): boolean {
    if (declared.has(key)) return false;
    declared.add(key);
    return true;
}

/** Limitations declared so far, in the order they were first declared. */
export function activeHostLimitations(): UserFacingFailureKey[] {
    return [...declared];
}

/** The MC-* codes for the declared limitations, for logs and reports. */
export function activeHostLimitationCodes(): string[] {
    return activeHostLimitations().map((key) => USER_FACING_FAILURES[key].code);
}

/** Test helper: forget every declared limitation so suites do not leak them. */
export function __resetHostLimitations(): void {
    declared.clear();
}
