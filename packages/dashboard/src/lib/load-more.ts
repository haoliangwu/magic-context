/**
 * Drives infinite scroll from an IntersectionObserver.
 *
 * The observer only reports changes in visibility. When a loaded page is too
 * short to push the sentinel out of view, the sentinel stays visible, no new
 * event arrives, and scrolling stops loading. This remembers whether the
 * sentinel is visible and asks for the next page again after each successful
 * load while it still is. `load` must itself do nothing when there is nothing
 * more to load or a load is already running.
 */
export class LoadMoreTrigger {
  private sentinelVisible = false;

  constructor(private readonly load: () => void) {}

  /** Feed each observer callback's visibility here. */
  onVisibilityChange(isIntersecting: boolean): void {
    this.sentinelVisible = isIntersecting;
    if (isIntersecting) this.load();
  }

  /**
   * Call after a page has loaded successfully and its rows are rendered state.
   * Not called after a failed load, so a failing request is not retried in a
   * tight loop while the sentinel stays on screen.
   */
  onPageLoaded(): void {
    if (this.sentinelVisible) this.load();
  }
}
