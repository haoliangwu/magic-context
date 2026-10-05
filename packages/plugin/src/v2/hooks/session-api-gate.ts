export const OPENCODE2_SESSION_API_NOTICE =
    "Magic Context is disabled: OpenCode 2.0.22 or newer is required (session.remove and session.compact). Upgrade OpenCode and restart.";

/** Capability checks also admit development builds without a release version. */
export function hasRequiredSessionAPI(session: object): boolean {
    const api = session as { remove?: unknown; compact?: unknown };
    return typeof api.remove === "function" && typeof api.compact === "function";
}
