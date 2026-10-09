import { describe, expect, test } from "bun:test";
import { livePollDue, UNFOCUSED_REFRESH_EVERY } from "./live-poll";

describe("livePollDue", () => {
  test("refreshes every tick while visible and focused", () => {
    expect(livePollDue({ hidden: false, focused: true, ticksSinceRefresh: 1 })).toBe(true);
  });

  test("never refreshes while hidden, however long it has been", () => {
    expect(livePollDue({ hidden: true, focused: false, ticksSinceRefresh: 10_000 })).toBe(false);
    expect(livePollDue({ hidden: true, focused: true, ticksSinceRefresh: 10_000 })).toBe(false);
  });

  test("backs off to one refresh per interval while visible but unfocused", () => {
    expect(
      livePollDue({
        hidden: false,
        focused: false,
        ticksSinceRefresh: UNFOCUSED_REFRESH_EVERY - 1,
      }),
    ).toBe(false);
    expect(
      livePollDue({ hidden: false, focused: false, ticksSinceRefresh: UNFOCUSED_REFRESH_EVERY }),
    ).toBe(true);
  });
});
