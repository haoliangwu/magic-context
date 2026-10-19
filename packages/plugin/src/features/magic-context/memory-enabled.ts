/** Memory opt-out applies to background providers as well as the main request. */
export function isProjectMemoryEnabled(enabled: boolean | undefined): boolean {
    return enabled !== false;
}

/** Keep disabled reads lazy: an opt-out must not load the project memory pool. */
export function readEnabledProjectMemories<T>(enabled: boolean | undefined, read: () => T[]): T[] {
    return isProjectMemoryEnabled(enabled) ? read() : [];
}
