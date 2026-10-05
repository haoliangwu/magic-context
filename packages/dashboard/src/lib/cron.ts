/**
 * Tiny, dependency-free cron helpers for the dreamer schedule UI.
 *
 * `describeCron` renders a human-readable summary for the common 5-field cron
 * shapes the dreamer UI produces (presets + simple custom entries). It is
 * deliberately CONSERVATIVE: anything it can't confidently describe falls back to
 * the raw expression rather than risk a wrong description. The plugin's cron
 * evaluator remains authoritative for actual scheduling.
 */

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/**
 * Allowed values per field, matching the plugin's cron parser
 * (`dreamer/cron.ts`): minute, hour, day-of-month, month, day-of-week (7 is
 * Sunday).
 */
const FIELD_RANGES: Array<[number, number]> = [
  [0, 59],
  [0, 23],
  [1, 31],
  [1, 12],
  [0, 7],
];

function fieldInRange(field: string, [min, max]: [number, number]): boolean {
  const inRange = (n: string) => Number(n) >= min && Number(n) <= max;
  if (field === "*") return true;
  const step = field.match(/^\*\/(\d+)$/);
  if (step) return Number(step[1]) >= 1;
  const range = field.match(/^(\d+)-(\d+)$/);
  if (range) return inRange(range[1]) && inRange(range[2]) && Number(range[1]) <= Number(range[2]);
  return /^\d+(,\d+)*$/.test(field) && field.split(",").every(inRange);
}

/**
 * 5-field check for inline UI feedback. Accepts the shapes the dreamer UI
 * produces (*, *\/n, a, a-b, a,b,c) with values in each field's range; the
 * plugin's parser remains authoritative and accepts a few more shapes.
 */
export function isValidCronShape(value: string): boolean {
  const v = value.trim();
  if (v === "") return true; // empty = disabled, valid
  const fields = v.split(/\s+/);
  if (fields.length !== 5) return false;
  return fields.every((field, i) => fieldInRange(field, FIELD_RANGES[i]));
}

/** English ordinal: 1st, 2nd, 3rd, 4th, 11th, 12th, 13th, 21st, 22nd, 23rd, 31st. */
function ordinal(n: number): string {
  const lastTwo = n % 100;
  if (lastTwo >= 11 && lastTwo <= 13) return `${n}th`;
  switch (n % 10) {
    case 1:
      return `${n}st`;
    case 2:
      return `${n}nd`;
    case 3:
      return `${n}rd`;
    default:
      return `${n}th`;
  }
}

function fmtTime(hour: number, minute: number): string {
  const period = hour < 12 ? "AM" : "PM";
  const h12 = hour % 12 === 0 ? 12 : hour % 12;
  const mm = minute.toString().padStart(2, "0");
  return `${h12}:${mm} ${period}`;
}

/** Human-readable description, or the raw cron when not confidently describable. */
export function describeCron(cron: string): string {
  const v = cron.trim();
  if (v === "") return "Disabled";
  if (!isValidCronShape(v)) return v;

  const [minute, hour, dom, month, dow] = v.split(/\s+/);

  // Every N minutes — "*/15 * * * *"
  const minStep = minute.match(/^\*\/(\d+)$/);
  if (minStep && hour === "*" && dom === "*" && month === "*" && dow === "*") {
    return `Every ${minStep[1]} minutes`;
  }
  // Every minute
  if (minute === "*" && hour === "*" && dom === "*" && month === "*" && dow === "*") {
    return "Every minute";
  }
  // Every N hours on the minute — "0 */6 * * *"
  const hourStep = hour.match(/^\*\/(\d+)$/);
  if (/^\d+$/.test(minute) && hourStep && dom === "*" && month === "*" && dow === "*") {
    const m = Number(minute);
    const at = m === 0 ? "" : ` at minute ${m}`;
    return `Every ${hourStep[1]} hours${at}`;
  }
  // Hourly — "0 * * * *"
  if (/^\d+$/.test(minute) && hour === "*" && dom === "*" && month === "*" && dow === "*") {
    const m = Number(minute);
    return m === 0 ? "Every hour" : `Every hour at minute ${m}`;
  }

  // Fixed time-of-day cases need numeric minute + hour.
  if (/^\d+$/.test(minute) && /^\d+$/.test(hour)) {
    const m = Number(minute);
    const h = Number(hour);
    if (m < 60 && h < 24) {
      const time = fmtTime(h, m);
      // Daily — "0 3 * * *"
      if (dom === "*" && month === "*" && dow === "*") return `Every day at ${time}`;
      // Weekly on one weekday — "0 4 * * 0"
      if (dom === "*" && month === "*" && /^\d+$/.test(dow)) {
        const d = Number(dow) % 7;
        return `Every ${DAY_NAMES[d]} at ${time}`;
      }
      // Monthly on a day-of-month — "0 3 1 * *"
      if (/^\d+$/.test(dom) && month === "*" && dow === "*") {
        return `Monthly on the ${ordinal(Number(dom))} at ${time}`;
      }
    }
  }

  // Confidently un-describable → show the raw cron (never guess wrong).
  return v;
}
