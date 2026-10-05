import { describe, expect, it } from "bun:test";
import { LoadMoreTrigger } from "./load-more";

describe("LoadMoreTrigger", () => {
  it("#given the sentinel stays visible after a page loads #then the next page is requested", () => {
    let loads = 0;
    const trigger = new LoadMoreTrigger(() => {
      loads += 1;
    });

    trigger.onVisibilityChange(true);
    expect(loads).toBe(1);
    // The short page did not scroll the sentinel away: no new observer event.
    trigger.onPageLoaded();
    expect(loads).toBe(2);
  });

  it("#given the sentinel scrolled out of view #then a finished page does not load another", () => {
    let loads = 0;
    const trigger = new LoadMoreTrigger(() => {
      loads += 1;
    });

    trigger.onVisibilityChange(true);
    trigger.onVisibilityChange(false);
    trigger.onPageLoaded();
    expect(loads).toBe(1);
  });
});
