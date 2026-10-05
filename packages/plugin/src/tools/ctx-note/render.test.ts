import { describe, expect, it } from "bun:test";

import {
    clipNoteTitle,
    EMPTY_READ_REPLY,
    formatGlanceRow,
    formatNoteAge,
    formatNoteBody,
    formatNoteNudge,
    formatWriteReply,
    noteNudgePickIndex,
    orderGlanceNotes,
    renderGlance,
    renderNotesById,
} from "./render";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;

const NOW = 1_700_000_000_000;

function note(overrides: Partial<Parameters<typeof formatGlanceRow>[0]> = {}) {
    return {
        id: 1,
        type: "session",
        status: "active",
        content: "A note",
        createdAt: NOW,
        updatedAt: NOW,
        ...overrides,
    };
}

describe("ctx_note glance rendering", () => {
    it("formats ages as minutes, hours, days, and weeks", () => {
        expect(formatNoteAge(NOW - 5 * MINUTE, NOW)).toBe("5m");
        expect(formatNoteAge(NOW - 3 * HOUR, NOW)).toBe("3h");
        expect(formatNoteAge(NOW - 2 * DAY, NOW)).toBe("2d");
        expect(formatNoteAge(NOW - 6 * WEEK, NOW)).toBe("6w");
        // A clock that runs backwards must not produce a negative age.
        expect(formatNoteAge(NOW + MINUTE, NOW)).toBe("0m");
    });

    it("clips the title to the first line and 80 characters", () => {
        expect(clipNoteTitle("Title\nsecond line", 80)).toBe("Title");
        expect(clipNoteTitle("x".repeat(80), 80)).toBe("x".repeat(80));
        expect(clipNoteTitle("x".repeat(81), 80)).toBe(`${"x".repeat(80)}…`);
    });

    it("renders one row per note as #id · age · title", () => {
        expect(formatGlanceRow(note({ id: 7, content: "Check the release" }), NOW)).toBe(
            "#7 · 0m · Check the release",
        );
    });

    it("marks non-active statuses and notes untouched for 30 days", () => {
        expect(
            formatGlanceRow(note({ id: 2, status: "ready", updatedAt: NOW - 2 * DAY }), NOW),
        ).toBe("#2 · 2d · A note · ready");
        expect(formatGlanceRow(note({ id: 3, updatedAt: NOW - 31 * DAY }), NOW)).toBe(
            "#3 · 4w · A note · stale",
        );
        expect(
            formatGlanceRow(note({ id: 4, status: "pending", updatedAt: NOW - 40 * DAY }), NOW),
        ).toBe("#4 · 5w · A note · pending · stale");
    });

    it("measures age from created_at when the note was never updated", () => {
        expect(formatGlanceRow(note({ id: 5, createdAt: NOW - 3 * HOUR, updatedAt: 0 }), NOW)).toBe(
            "#5 · 3h · A note",
        );
    });

    it("orders ready smart notes, then pending, then the rest, newest first", () => {
        const ordered = orderGlanceNotes([
            note({ id: 1, updatedAt: NOW - 3 * DAY }),
            note({ id: 2, status: "pending", updatedAt: NOW - 2 * DAY }),
            note({ id: 3, status: "ready", updatedAt: NOW - 5 * DAY }),
            note({ id: 4, status: "ready", updatedAt: NOW - 1 * DAY }),
            note({ id: 5, updatedAt: NOW - 4 * DAY }),
        ]);
        expect(ordered.map((entry) => entry.id)).toEqual([4, 3, 2, 1, 5]);
    });

    it("renders the glance with a one-line paging footer", () => {
        const notes = Array.from({ length: 30 }, (_, index) =>
            note({
                id: index + 1,
                content: `note ${index + 1}`,
                updatedAt: NOW - (30 - (index + 1)) * MINUTE,
            }),
        );
        const page = renderGlance(notes, { limit: 25, offset: 0, nowMs: NOW });
        expect(page.startsWith("## Notes\n\n#30 · 0m · note 30\n")).toBe(true);
        expect(page).toContain("#6 · 24m · note 6");
        expect(page).not.toContain("note 5\n");
        expect(page).toContain('Showing 25 of 30 — 5 older: ctx_note(action="read", offset=25)');

        const lastPage = renderGlance(notes, { limit: 25, offset: 25, nowMs: NOW });
        expect(lastPage).toContain("note 5");
        expect(lastPage).toContain("note 1");
        expect(lastPage).not.toContain("older: ctx_note");
    });

    it("returns the empty reply when there is nothing to show", () => {
        expect(renderGlance([], { limit: 25, offset: 0, nowMs: NOW })).toBe(EMPTY_READ_REPLY);
        expect(renderGlance([note()], { limit: 25, offset: 5, nowMs: NOW })).toBe(EMPTY_READ_REPLY);
    });

    it("renders full bodies in the order the ids were given", () => {
        const bodies = renderNotesById(
            [
                { noteId: 3, note: { ...note({ id: 3, content: "third" }), anchorOrdinal: null } },
                { noteId: 1, note: { ...note({ id: 1, content: "first" }), anchorOrdinal: 512 } },
                { noteId: 9, note: null },
            ],
            NOW,
        );
        expect(bodies).toBe(
            "## Notes by ID\n\n" +
                "- **#3** · 0m · active: third\n\n" +
                "- **#1** · 0m · active: first ↳ @msg 512\n\n" +
                "- Note #9: not_found",
        );
    });

    it("carries the condition on a smart note body", () => {
        expect(
            formatNoteBody(
                {
                    ...note({ id: 4, type: "smart", status: "ready", content: "Ship it" }),
                    anchorOrdinal: null,
                    surfaceCondition: "when the tag exists",
                    readyReason: "tag v2 exists",
                },
                NOW,
            ),
        ).toBe("- **#4** · 0m · ready: Ship it\n  Condition met: tag v2 exists");
    });

    it("shows the parked reason in both the glance and full body", () => {
        const parked = {
            ...note({ type: "smart", status: "pending", content: "Watch schema" }),
            checkStatus: "parked",
            readyReason: "Condition can't be checked: source is not publicly readable; rewrite it",
            surfaceCondition: "schema appears",
            anchorOrdinal: null,
        };
        expect(formatGlanceRow(parked, NOW)).toBe(
            "#1 · 0m · Watch schema · pending · parked: Condition can't be checked: source is not publicly readable; rewrite it",
        );
        expect(formatNoteBody(parked, NOW)).toBe(
            "- **#1** · 0m · pending: Watch schema\n  Condition: schema appears\n  Condition can't be checked: source is not publicly readable; rewrite it",
        );
    });

    it("appends the tray line to a write reply only when the tray is non-empty", () => {
        expect(formatWriteReply(1, { activeCount: 0, oldestTouchedAt: null }, NOW)).toBe(
            "Saved session note #1.",
        );
        expect(formatWriteReply(2, { activeCount: 3, oldestTouchedAt: NOW - 2 * DAY }, NOW)).toBe(
            "Saved session note #2. 3 active, oldest 2d.",
        );
    });

    it("picks deterministically and walks the pool as the counter advances", () => {
        const picks = [0, 1, 2, 3].map((counter) => noteNudgePickIndex("ses-a", counter, 3));
        expect(picks).toEqual(
            [0, 1, 2, 3].map((counter) => noteNudgePickIndex("ses-a", counter, 3)),
        );
        expect(new Set(picks).size).toBeGreaterThan(1);
        expect(noteNudgePickIndex("ses-a", 0, 0)).toBe(0);
    });

    it("renders the nudge line with counts first and one clipped title", () => {
        expect(
            formatNoteNudge({
                readyCount: 0,
                activeCount: 2,
                oldestActiveTouchedAt: NOW - 3 * HOUR,
                shown: note({ id: 5, content: "x".repeat(70) }),
                nowMs: NOW,
            }),
        ).toBe(`0 notes ready, 2 active (oldest 3h): #5 ${"x".repeat(60)}…`);
        expect(
            formatNoteNudge({
                readyCount: 1,
                activeCount: 0,
                oldestActiveTouchedAt: null,
                shown: null,
                nowMs: NOW,
            }),
        ).toBe("1 notes ready, 0 active");
    });

    it("renders the shared five-note fixture byte-for-byte", () => {
        // The same fixture is pinned in crates/mc-module/src/lib.rs
        // (`note_facade_glance_lists_one_row_per_note_with_age_and_stale_markers`),
        // so a format change on one leg without the other goes red here.
        const day = DAY;
        const fixture = [
            note({
                id: 1,
                type: "smart",
                status: "ready",
                content: "Ready smart item",
                updatedAt: NOW - 5 * day,
            }),
            note({
                id: 2,
                type: "smart",
                status: "pending",
                content: "Parked smart item",
                updatedAt: NOW - 2 * day,
            }),
            note({ id: 3, content: "Fresh plain item", updatedAt: NOW }),
            note({ id: 4, content: "Two-day-old plain item", updatedAt: NOW - 2 * day }),
            note({ id: 5, content: "Forty-day-old plain item", updatedAt: NOW - 40 * day }),
        ];
        expect(renderGlance(fixture, { limit: 25, offset: 0, nowMs: NOW })).toBe(
            "## Notes\n\n" +
                "#1 · 5d · Ready smart item · ready\n" +
                "#2 · 2d · Parked smart item · pending\n" +
                "#3 · 0m · Fresh plain item\n" +
                "#4 · 2d · Two-day-old plain item\n" +
                "#5 · 5w · Forty-day-old plain item · stale",
        );
    });
});
