import { describeCron } from "../../lib/cron";
import type { DreamTaskConfig } from "./DreamerTasksField";

export function patchTaskConfig(
  tasks: Record<string, DreamTaskConfig> | undefined,
  name: string,
  patch: Partial<DreamTaskConfig>,
): Record<string, DreamTaskConfig> {
  const next = { ...tasks, [name]: { ...tasks?.[name], ...patch } };
  for (const key of Object.keys(next[name])) {
    if (next[name][key] === undefined) delete next[name][key];
  }
  return next;
}

export function toggledSchedule(
  enabled: boolean,
  previous: string | undefined,
  preset: string,
): string {
  return enabled ? (previous?.trim() ? previous : preset || "0 3 * * *") : "";
}

/** Keep unfamiliar expressions honest instead of guessing their scheduling semantics. */
export function scheduleSummary(schedule: string): string {
  const description = describeCron(schedule);
  if (description === schedule.trim() && schedule.trim()) return "Custom cron · edit";
  return description.replace(
    /(\d+):(\d+) (AM|PM)/g,
    (_match, hours: string, minutes: string, period: string) => {
      const hour = (Number(hours) % 12) + (period === "PM" ? 12 : 0);
      return `${String(hour).padStart(2, "0")}:${minutes}`;
    },
  );
}
