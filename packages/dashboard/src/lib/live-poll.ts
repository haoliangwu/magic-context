// When the Cache tab's one-second live refresh actually runs.
//
// Every refresh re-lists sessions and reads whatever each recent session
// appended, so it costs disk reads and CPU in the backend even when nothing is
// on screen. The dashboard is a long-lived tray app, often left open behind
// other windows for hours, so the refresh runs every tick only while the
// window is visible and focused, every UNFOCUSED_REFRESH_EVERY ticks while it
// is visible but in the background, and not at all while it is hidden. Coming
// back to the window refreshes at once (see CacheDiagnostics).

/** Ticks between refreshes while the window is visible but not focused. */
export const UNFOCUSED_REFRESH_EVERY = 10;

export interface LivePollState {
  /** `document.visibilityState === "hidden"`: minimized, closed to tray, or another tab. */
  hidden: boolean;
  /** `document.hasFocus()`. */
  focused: boolean;
  /** Ticks since the last refresh that ran. */
  ticksSinceRefresh: number;
}

export function livePollDue(state: LivePollState): boolean {
  if (state.hidden) return false;
  if (state.focused) return true;
  return state.ticksSinceRefresh >= UNFOCUSED_REFRESH_EVERY;
}
