/**
 * Debug / data-collection switch for every settled Magic Context child session,
 * including historian, Dreamer, smart-note, user-memory, and migration work.
 *
 * Unsettled children are never deleted inline because OpenCode's server loop may
 * still be writing after a client timeout or abort. They remain archived for the
 * age-gated sweep; archived privacy-sensitive rows are swept even when this
 * switch is on.
 *
 * Process-global, set once at boot from config (mirrors `harness.ts`). A config
 * change requires a restart to take effect.
 */
let keepSubagents = false;

/** Set at plugin boot from `keep_subagents` config. */
export function setKeepSubagents(value: boolean): void {
    keepSubagents = value === true;
}

/** True when every settled Magic Context child session should be retained. */
export function shouldKeepSubagents(): boolean {
    return keepSubagents;
}

/** Test-only reset. Do NOT call from production paths. */
export function _resetKeepSubagentsForTesting(): void {
    keepSubagents = false;
}
