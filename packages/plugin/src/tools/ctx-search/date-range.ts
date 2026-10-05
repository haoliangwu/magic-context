export interface ParsedSearchDateRange {
    from?: number;
    to?: number;
}

export class SearchDateRangeError extends Error {
    readonly code = "invalid_search_date_range";
}

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;
const FULL_ISO = /^\d{4}-\d{2}-\d{2}T.+(?:Z|[+-]\d{2}:\d{2})$/;

function parseDate(value: string, field: "from" | "to"): number {
    const trimmed = value.trim();
    const dateOnly = DATE_ONLY.exec(trimmed);
    if (dateOnly) {
        const year = Number(dateOnly[1]);
        const month = Number(dateOnly[2]);
        const day = Number(dateOnly[3]);
        const start = Date.UTC(year, month - 1, day);
        const roundTrip = new Date(start);
        if (
            roundTrip.getUTCFullYear() !== year ||
            roundTrip.getUTCMonth() !== month - 1 ||
            roundTrip.getUTCDate() !== day
        ) {
            throw new SearchDateRangeError(
                `Invalid '${field}' date; use YYYY-MM-DD or a full ISO datetime.`,
            );
        }
        return field === "to" ? start + 24 * 60 * 60 * 1000 - 1 : start;
    }

    if (FULL_ISO.test(trimmed)) {
        const parsed = Date.parse(trimmed);
        if (Number.isSafeInteger(parsed)) return parsed;
    }
    throw new SearchDateRangeError(
        `Invalid '${field}' date; use YYYY-MM-DD or a full ISO datetime.`,
    );
}

export function parseSearchDateRange(
    from: string | undefined,
    to: string | undefined,
): ParsedSearchDateRange {
    const parsed = {
        ...(from === undefined ? {} : { from: parseDate(from, "from") }),
        ...(to === undefined ? {} : { to: parseDate(to, "to") }),
    };
    if (parsed.from !== undefined && parsed.to !== undefined && parsed.from > parsed.to) {
        throw new SearchDateRangeError("Invalid date range; 'from' must be on or before 'to'.");
    }
    return parsed;
}
