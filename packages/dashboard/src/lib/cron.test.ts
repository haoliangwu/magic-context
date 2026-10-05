import { describe, expect, it } from "bun:test";
import { describeCron, isValidCronShape } from "./cron";

describe("isValidCronShape", () => {
  it("accepts empty (disabled) and well-formed 5-field crons", () => {
    expect(isValidCronShape("")).toBe(true);
    expect(isValidCronShape("0 3 * * *")).toBe(true);
    expect(isValidCronShape("*/15 * * * *")).toBe(true);
    expect(isValidCronShape("0 4 * * 0")).toBe(true);
  });

  it("rejects values outside each field's range and zero steps", () => {
    expect(isValidCronShape("0 3 * * 8")).toBe(false);
    expect(isValidCronShape("0 3 * * 7")).toBe(true);
    expect(isValidCronShape("*/0 * * * *")).toBe(false);
    expect(isValidCronShape("60 * * * *")).toBe(false);
    expect(isValidCronShape("0 24 * * *")).toBe(false);
    expect(isValidCronShape("0 0 0 * *")).toBe(false);
    expect(isValidCronShape("0 0 * 13 *")).toBe(false);
    expect(isValidCronShape("0 0 * * 5-2")).toBe(false);
    expect(isValidCronShape("0 0 1,15,31 * 1-5")).toBe(true);
  });

  it("rejects wrong field counts and garbage", () => {
    expect(isValidCronShape("0 3 * *")).toBe(false);
    expect(isValidCronShape("0 3 * * * *")).toBe(false);
    expect(isValidCronShape("hello world foo bar baz")).toBe(false);
  });
});

describe("describeCron", () => {
  it("describes the dreamer preset shapes", () => {
    expect(describeCron("")).toBe("Disabled");
    expect(describeCron("0 3 * * *")).toBe("Every day at 3:00 AM");
    expect(describeCron("0 4 * * 0")).toBe("Every Sunday at 4:00 AM");
    expect(describeCron("0 */6 * * *")).toBe("Every 6 hours");
    expect(describeCron("0 * * * *")).toBe("Every hour");
  });

  it("describes common custom shapes", () => {
    expect(describeCron("*/15 * * * *")).toBe("Every 15 minutes");
    expect(describeCron("30 8 * * *")).toBe("Every day at 8:30 AM");
    expect(describeCron("0 14 * * 5")).toBe("Every Friday at 2:00 PM");
    expect(describeCron("0 0 1 * *")).toBe("Monthly on the 1st at 12:00 AM");
  });

  it("uses correct ordinals for every day of the month", () => {
    const ordinals = [1, 2, 3, 4, 11, 12, 13, 21, 22, 23, 31].map((d) =>
      describeCron(`0 3 ${d} * *`).replace(/^Monthly on the (\S+) at .*$/, "$1"),
    );
    expect(ordinals).toEqual([
      "1st",
      "2nd",
      "3rd",
      "4th",
      "11th",
      "12th",
      "13th",
      "21st",
      "22nd",
      "23rd",
      "31st",
    ]);
  });

  it("does not describe an out-of-range weekday as a real day", () => {
    expect(describeCron("0 4 * * 8")).toBe("0 4 * * 8");
    expect(describeCron("0 4 * * 7")).toBe("Every Sunday at 4:00 AM");
  });

  it("falls back to the raw cron when not confidently describable", () => {
    expect(describeCron("0 0 1 1 *")).toBe("0 0 1 1 *");
    expect(describeCron("5,10,15 * * * *")).toBe("5,10,15 * * * *");
    expect(describeCron("not a cron")).toBe("not a cron");
  });
});
