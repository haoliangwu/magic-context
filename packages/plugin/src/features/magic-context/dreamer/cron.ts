/**
 * Minimal 5-field cron evaluator for per-task dreamer scheduling.
 *
 * Why vendored (no dependency): we only need "next occurrence after time T", the
 * 3-day package-release-age floor makes pulling a dep awkward, and the surface is
 * small. Shared core — both OpenCode and Pi import this via @magic-context/core.
 *
 * Fields: `minute hour day-of-month month day-of-week`
 *   minute 0-59 · hour 0-23 · dom 1-31 · month 1-12 · dow 0-6 (0 or 7 = Sunday)
 * Each field supports: a star wildcard, a star-with-step (every-N), a single
 * value `a`, a range `a-b`, a range-with-step `a-b/step`, an open step `a/step`
 * (a..max), and comma-lists of any of those. Numeric only — month and weekday
 * NAMES are intentionally unsupported (smaller surface; add later if asked).
 * Empty string `""` means "never" and is handled by the caller, not here.
 *
 * Day matching follows Vixie cron: a dom or dow field that starts with `*`
 * (`*` itself or a star-step such as `*\/2`) counts as unrestricted. When BOTH
 * fields are restricted a day matches if EITHER matches; otherwise a day must
 * match both sets, which for a plain `*` field means only the other one counts.
 *
 * Timezone: all matching is in the machine's LOCAL time — the dreamer's whole
 * purpose is "run while the user is asleep", which is a wall-clock concept.
 * nextOccurrence steps by real (epoch) minutes and reads LOCAL civil fields off
 * each candidate, so DST transitions are handled correctly by construction (no
 * setHours/local-constructor normalization, which is DST-ambiguous).
 */

export interface ParsedCron {
    minute: Set<number>;
    hour: Set<number>;
    dom: Set<number>;
    month: Set<number>;
    dow: Set<number>;
    /** Field token does not start with `*` — drives Vixie dom/dow OR-semantics. */
    domRestricted: boolean;
    dowRestricted: boolean;
}

export type ParseCronResult = { ok: true; cron: ParsedCron } | { ok: false; error: string };

interface FieldSpec {
    name: string;
    min: number;
    max: number;
}

const FIELDS: FieldSpec[] = [
    { name: "minute", min: 0, max: 59 },
    { name: "hour", min: 0, max: 23 },
    { name: "day-of-month", min: 1, max: 31 },
    { name: "month", min: 1, max: 12 },
    { name: "day-of-week", min: 0, max: 7 }, // 7 normalized to 0 (Sunday)
];

const MINUTE_MS = 60_000;
/**
 * Forward search bound for nextOccurrence. ~4 years covers Feb-29-only crons
 * (leap years are ≤4 apart) and the longest legitimate gaps; anything past it is
 * treated as "never" (e.g. an impossible `0 0 31 2 *` — Feb 31). Generous so a
 * valid-but-rare schedule is never wrongly reported as never.
 */
const MAX_SEARCH_MS = 4 * 366 * 24 * 60 * MINUTE_MS;

/** Parse one field into the set of matching values, or null on error. */
function parseField(token: string, spec: FieldSpec): Set<number> | null {
    const values = new Set<number>();
    const normalize = (n: number): number => (spec.name === "day-of-week" && n === 7 ? 0 : n);

    for (const part of token.split(",")) {
        const piece = part.trim();
        if (piece.length === 0) return null;

        // Split off an optional /step.
        const [rangePart, stepPart, ...extra] = piece.split("/");
        if (extra.length > 0) return null;
        let step = 1;
        if (stepPart !== undefined) {
            if (!/^\d+$/.test(stepPart)) return null;
            step = Number(stepPart);
            if (step < 1) return null;
        }

        let lo: number;
        let hi: number;
        if (rangePart === "*") {
            lo = spec.min;
            hi = spec.max;
        } else if (rangePart.includes("-")) {
            const [loStr, hiStr, ...rest] = rangePart.split("-");
            if (rest.length > 0) return null;
            if (!/^\d+$/.test(loStr) || !/^\d+$/.test(hiStr)) return null;
            lo = Number(loStr);
            hi = Number(hiStr);
        } else {
            if (!/^\d+$/.test(rangePart)) return null;
            lo = Number(rangePart);
            // `a/step` (no upper bound) means a..max by step.
            hi = stepPart !== undefined ? spec.max : lo;
        }

        // Validate against the field range BEFORE dow-7 normalization so `7` is
        // accepted (it's a valid Sunday alias) but `8` is rejected.
        if (lo < spec.min || lo > spec.max || hi < spec.min || hi > spec.max) return null;
        if (lo > hi) return null;

        for (let v = lo; v <= hi; v += step) {
            values.add(normalize(v));
        }
    }

    return values.size > 0 ? values : null;
}

/** Parse a 5-field cron expression. Empty/whitespace is rejected here — callers
 *  treat `""` as "never" before calling. */
export function parseCron(expression: string): ParseCronResult {
    const trimmed = expression.trim();
    if (trimmed.length === 0) {
        return { ok: false, error: "empty cron expression" };
    }
    const tokens = trimmed.split(/\s+/);
    if (tokens.length !== 5) {
        return {
            ok: false,
            error: `expected 5 fields (minute hour day-of-month month day-of-week), got ${tokens.length}`,
        };
    }

    const sets: Set<number>[] = [];
    for (let i = 0; i < FIELDS.length; i++) {
        const parsed = parseField(tokens[i], FIELDS[i]);
        if (!parsed) {
            return {
                ok: false,
                error: `invalid ${FIELDS[i].name} field "${tokens[i]}" (allowed ${FIELDS[i].min}-${FIELDS[i].max})`,
            };
        }
        sets.push(parsed);
    }

    return {
        ok: true,
        cron: {
            minute: sets[0],
            hour: sets[1],
            dom: sets[2],
            month: sets[3],
            dow: sets[4],
            // Vixie cron treats any star-prefixed field (`*`, `*/2`) as
            // unrestricted when choosing between OR and AND day matching.
            domRestricted: !tokens[2].startsWith("*"),
            dowRestricted: !tokens[4].startsWith("*"),
        },
    };
}

/** True if the expression parses; thin wrapper for config validation. */
export function isValidCron(expression: string): boolean {
    return parseCron(expression).ok;
}

function matchesDay(cron: ParsedCron, date: Date): boolean {
    const dom = cron.dom.has(date.getDate());
    const dow = cron.dow.has(date.getDay());
    if (cron.domRestricted && cron.dowRestricted) return dom || dow;
    return dom && dow;
}

/** Longest each month can be, counting Feb 29. */
const MAX_DAYS_IN_MONTH = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

/**
 * False when the day-of-month set fits in none of the cron's months (e.g.
 * `0 0 31 2 *`, Feb 31), so the schedule can never fire. Lets nextOccurrence
 * answer "never" at once instead of scanning ~2 million minutes on every
 * evaluation. A restricted weekday under OR-matching always fires eventually.
 */
function dayOfMonthCanOccur(cron: ParsedCron): boolean {
    if (cron.domRestricted && cron.dowRestricted) return true;
    for (const month of cron.month) {
        for (const day of cron.dom) {
            if (day <= MAX_DAYS_IN_MONTH[month - 1]) return true;
        }
    }
    return false;
}

/** True if `date`'s local civil fields match the cron. */
export function matchesCron(cron: ParsedCron, date: Date): boolean {
    return (
        cron.minute.has(date.getMinutes()) &&
        cron.hour.has(date.getHours()) &&
        cron.month.has(date.getMonth() + 1) &&
        matchesDay(cron, date)
    );
}

/** Local civil-minute key `YYYY-MM-DD HH:mm` — used to dedupe the repeated wall
 *  minute on a DST fall-back so a run isn't fired twice for the same slot. */
function civilMinuteKey(date: Date): string {
    const p = (n: number, w = 2) => String(n).padStart(w, "0");
    return `${p(date.getFullYear(), 4)}-${p(date.getMonth() + 1)}-${p(date.getDate())} ${p(date.getHours())}:${p(date.getMinutes())}`;
}

/**
 * First instant strictly after `after` whose LOCAL civil time matches `cron`.
 * Returns null if none within the ~4-year cap (effectively-never schedules).
 *
 * @param excludeCivilMinute Skip any candidate sharing this `YYYY-MM-DD HH:mm`
 *   key. Pass the just-consumed run's scheduled civil minute when advancing
 *   `next_due_at` so a DST fall-back's repeated wall minute doesn't double-fire
 *   the same daily slot. (For sub-hourly every-N schedules, only the exact
 *   consumed minute is skipped; the other repeated-hour minutes still fire, which
 *   is correct — more real time elapsed.)
 */
export function nextOccurrence(
    cron: ParsedCron,
    after: Date,
    excludeCivilMinute?: string,
    maxSearchMs = MAX_SEARCH_MS,
): Date | null {
    if (!dayOfMonthCanOccur(cron)) return null;
    const afterMs = after.getTime();
    // Align to the next whole minute strictly after `after` (never returns `after`).
    let cursorMs = Math.floor(afterMs / MINUTE_MS) * MINUTE_MS + MINUTE_MS;
    const capMs = afterMs + Math.max(0, Math.min(MAX_SEARCH_MS, maxSearchMs));

    while (cursorMs <= capMs) {
        const candidate = new Date(cursorMs);
        if (matchesCron(cron, candidate)) {
            if (!excludeCivilMinute || civilMinuteKey(candidate) !== excludeCivilMinute) {
                return candidate;
            }
        }
        cursorMs += MINUTE_MS;
    }
    return null;
}

/**
 * Convenience: parse + compute next-due epoch (ms) for a schedule string.
 * Returns null for `""` / invalid / effectively-never schedules — the caller
 * persists `next_due_at = NULL` in all of those cases.
 *
 * @param consumedScheduledAtMs When advancing after a run, pass the epoch of the
 *   slot just satisfied (the prior `next_due_at`); its civil minute is excluded
 *   to prevent the DST repeated-minute double-fire.
 */
export function nextDueAtMs(
    expression: string,
    afterMs: number,
    consumedScheduledAtMs?: number,
    maxSearchMs = MAX_SEARCH_MS,
): number | null {
    if (expression.trim().length === 0) return null;
    const parsed = parseCron(expression);
    if (!parsed.ok) return null;
    const exclude =
        consumedScheduledAtMs !== undefined
            ? civilMinuteKey(new Date(consumedScheduledAtMs))
            : undefined;
    const next = nextOccurrence(parsed.cron, new Date(afterMs), exclude, maxSearchMs);
    return next ? next.getTime() : null;
}
