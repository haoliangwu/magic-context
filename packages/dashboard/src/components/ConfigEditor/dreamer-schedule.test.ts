import { describe, expect, it } from "bun:test";
import { patchTaskConfig, scheduleSummary, toggledSchedule } from "./dreamer-schedule";

describe("dreamer schedule table", () => {
  it("maps off to an empty schedule and on to the last custom schedule", () => {
    const previous = "15 14 * * 2";
    expect(toggledSchedule(false, previous, "0 3 * * *")).toBe("");
    expect(toggledSchedule(true, previous, "0 3 * * *")).toBe(previous);
    expect(toggledSchedule(true, undefined, "0 2 * * *")).toBe("0 2 * * *");
    expect(toggledSchedule(true, undefined, "")).toBe("0 3 * * *");
  });

  it("writes only the selected schedule, not a synthetic enabled flag or other task defaults", () => {
    const tasks = {
      verify: { schedule: "0 3 * * *", token_budget: 1234 },
      unknown: { schedule: "custom", custom: true },
    };
    expect(
      patchTaskConfig(tasks, "verify", {
        schedule: toggledSchedule(false, tasks.verify.schedule, "0 3 * * *"),
      }),
    ).toEqual({
      verify: { schedule: "", token_budget: 1234 },
      unknown: { schedule: "custom", custom: true },
    });
    expect(tasks.verify.schedule).toBe("0 3 * * *");
    expect(patchTaskConfig(undefined, "verify", { schedule: "" })).toEqual({
      verify: { schedule: "" },
    });
  });

  it("clears promotion overrides without disturbing schedules or advanced fields", () => {
    expect(
      patchTaskConfig(
        { "promote-primers": { schedule: "", promotion_threshold: 5, custom: 1 } },
        "promote-primers",
        { promotion_threshold: undefined },
      ),
    ).toEqual({ "promote-primers": { schedule: "", custom: 1 } });
  });

  it("describes known schedules in 24-hour time and leaves custom cron for the detail editor", () => {
    expect(scheduleSummary("0 3 * * *")).toBe("Every day at 03:00");
    expect(scheduleSummary("15 14 * * 2")).toBe("Every Tuesday at 14:15");
    expect(scheduleSummary("0 */6 * * *")).toBe("Every 6 hours");
    expect(scheduleSummary("1,3 4 5 6 *")).toBe("Custom cron · edit");
    expect(scheduleSummary("")).toBe("Disabled");
  });
});
