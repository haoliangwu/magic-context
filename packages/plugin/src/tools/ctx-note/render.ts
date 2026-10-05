/**
 * Rendering for the ctx_note read glance, the bodies-by-id view, the write
 * footer, and the one-line note nudge.
 *
 * The OpenCode plugin, the Pi plugin, and the Rust module facade must emit the
 * same bytes for the same rows, so every format decision lives here and is
 * mirrored in `crates/mc-module/src/lib.rs`. Change one, change the other.
 */

/** Title clip for a glance row. */
export const GLANCE_TITLE_MAX = 80;
/** Title clip for the single line the note nudge shows. */
export const NUDGE_TITLE_MAX = 60;
/** A note untouched for this long is marked stale in the glance. */
export const STALE_AFTER_MS = 30 * 24 * 60 * 60 * 1000;

/** The reply for a read that has nothing to show. */
export const EMPTY_READ_REPLY = "## Notes\n\nNo session notes or smart notes.";

export interface GlanceNote {
    id: number;
    type: string;
    status: string;
    content: string;
    createdAt: number;
    updatedAt: number;
    checkStatus?: string | null;
    readyReason?: string | null;
}

export interface NoteBodySource extends GlanceNote {
    anchorOrdinal: number | null;
    surfaceCondition?: string | null;
    readyReason?: string | null;
}

/** The timestamp a note's age is measured from: its last update, or its
 *  creation when it has never been updated. */
export function noteTouchedAt(note: Pick<GlanceNote, "createdAt" | "updatedAt">): number {
    return note.updatedAt > 0 ? note.updatedAt : note.createdAt;
}

/** Compact age: `5m`, `3h`, `2d`, `6w`. */
export function formatNoteAge(touchedAt: number, nowMs: number): string {
    const elapsed = Math.max(0, nowMs - touchedAt);
    const minutes = Math.floor(elapsed / 60_000);
    if (minutes < 60) return `${minutes}m`;
    const hours = Math.floor(elapsed / 3_600_000);
    if (hours < 24) return `${hours}h`;
    const days = Math.floor(elapsed / 86_400_000);
    if (days < 7) return `${days}d`;
    return `${Math.floor(days / 7)}w`;
}

/** First line of the note content, clipped to `max` characters with `…`. */
export function clipNoteTitle(content: string, max: number): string {
    const firstLine = (content.split("\n", 1)[0] ?? "").trim();
    const characters = [...firstLine];
    if (characters.length <= max) return firstLine;
    return `${characters.slice(0, max).join("")}…`;
}

/** One glance row: `#id · age · title`, plus `· <status>` for anything that is
 *  not active and `· stale` when the note has not been touched for 30 days. */
export function formatGlanceRow(note: GlanceNote, nowMs: number): string {
    const touchedAt = noteTouchedAt(note);
    const markers: string[] = [];
    if (note.status !== "active") markers.push(note.status);
    if (note.type === "smart" && note.status === "pending" && note.checkStatus === "parked") {
        markers.push(`parked: ${note.readyReason ?? "Condition can't be checked"}`);
    }
    if (nowMs - touchedAt >= STALE_AFTER_MS) markers.push("stale");
    const suffix = markers.length > 0 ? ` · ${markers.join(" · ")}` : "";
    const title = clipNoteTitle(note.content, GLANCE_TITLE_MAX);
    return `#${note.id} · ${formatNoteAge(touchedAt, nowMs)} · ${title}${suffix}`;
}

function newestFirst(left: GlanceNote, right: GlanceNote): number {
    return right.updatedAt - left.updatedAt || right.id - left.id;
}

/** Glance order: ready smart notes first, then pending smart notes, then every
 *  other status — each group newest first. */
export function orderGlanceNotes(notes: readonly GlanceNote[]): GlanceNote[] {
    const ready = notes.filter((note) => note.status === "ready").sort(newestFirst);
    const pending = notes.filter((note) => note.status === "pending").sort(newestFirst);
    const rest = notes
        .filter((note) => note.status !== "ready" && note.status !== "pending")
        .sort(newestFirst);
    return [...ready, ...pending, ...rest];
}

/** The whole glance: one row per note, then the one-line paging footer. */
export function renderGlance(
    notes: readonly GlanceNote[],
    options: { limit: number; offset: number; nowMs: number },
): string {
    const ordered = orderGlanceNotes(notes);
    const page = ordered.slice(options.offset, options.offset + options.limit);
    if (page.length === 0) return EMPTY_READ_REPLY;
    const rows = page.map((note) => formatGlanceRow(note, options.nowMs)).join("\n");
    const remaining = ordered.length - options.offset - page.length;
    const footer =
        remaining > 0
            ? `\n\nShowing ${page.length} of ${ordered.length} — ${remaining} older: ctx_note(action="read", offset=${options.offset + page.length})`
            : "";
    return `## Notes\n\n${rows}${footer}`;
}

/** Full body for one note in the bodies-by-id view: `#id`, age, status, the
 *  content, and the `↳ @msg N` anchor when the note carries one. Smart notes
 *  also carry the condition that parked them. */
export function formatNoteBody(note: NoteBodySource, nowMs: number): string {
    const touchedAt = noteTouchedAt(note);
    const anchor = note.anchorOrdinal !== null ? ` ↳ @msg ${note.anchorOrdinal}` : "";
    const head = `- **#${note.id}** · ${formatNoteAge(touchedAt, nowMs)} · ${note.status}: ${note.content}${anchor}`;
    if (note.type !== "smart") return head;
    const condition =
        note.status === "ready"
            ? (note.readyReason ?? note.surfaceCondition ?? "Condition satisfied")
            : (note.surfaceCondition ?? "No condition recorded");
    const label = note.status === "ready" ? "Condition met" : "Condition";
    const failure =
        note.status === "pending" && note.readyReason?.startsWith("Condition can't be checked:")
            ? `\n  ${note.readyReason}`
            : "";
    return `${head}\n  ${label}: ${condition}${failure}`;
}

/** Bodies-by-id view. Ids that are unknown or owned by someone else render the
 *  same `not_found` line, so the reply never discloses whether an inaccessible
 *  note exists. */
export function renderNotesById(
    entries: ReadonlyArray<{ noteId: number; note: NoteBodySource | null }>,
    nowMs: number,
): string {
    const lines = entries.map(({ noteId, note }) =>
        note ? formatNoteBody(note, nowMs) : `- Note #${noteId}: not_found`,
    );
    return `## Notes by ID\n\n${lines.join("\n\n")}`;
}

/** The tray line appended to a write reply: how many active session notes the
 *  writer now holds and how old the oldest one is. Empty when the tray is
 *  empty, so a first write stays a single short line. */
export function formatTraySuffix(
    tray: { activeCount: number; oldestTouchedAt: number | null },
    nowMs: number,
): string {
    if (tray.activeCount <= 0 || tray.oldestTouchedAt === null) return "";
    return ` ${tray.activeCount} active, oldest ${formatNoteAge(tray.oldestTouchedAt, nowMs)}.`;
}

/** The write reply: the saved-note line plus the tray line, so the writer sees
 *  the backlog at the moment they add to it. */
export function formatWriteReply(
    noteId: number,
    tray: { activeCount: number; oldestTouchedAt: number | null },
    nowMs: number,
): string {
    return `Saved session note #${noteId}.${formatTraySuffix(tray, nowMs)}`;
}

/**
 * Stateless pick over a pool of `poolSize` notes: FNV-1a over the UTF-8 bytes
 * of `${sessionId}#${counter}`. Successive nudges use successive counters, so
 * they surface different notes, while a replayed delivery keeps the bytes it
 * was stored with. Mirrored in Rust.
 */
export function noteNudgePickIndex(sessionId: string, counter: number, poolSize: number): number {
    if (poolSize <= 0) return 0;
    const bytes = new TextEncoder().encode(`${sessionId}#${counter}`);
    let hash = 0x811c9dc5;
    for (const byte of bytes) {
        hash ^= byte;
        hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash % poolSize;
}

/** The one-line note nudge: counts first, then one clipped title. */
export function formatNoteNudge(args: {
    readyCount: number;
    activeCount: number;
    oldestActiveTouchedAt: number | null;
    shown: GlanceNote | null;
    nowMs: number;
}): string {
    const counts = `${args.readyCount} notes ready, ${args.activeCount} active`;
    const oldest =
        args.activeCount > 0 && args.oldestActiveTouchedAt !== null
            ? ` (oldest ${formatNoteAge(args.oldestActiveTouchedAt, args.nowMs)})`
            : "";
    const shown = args.shown
        ? `: #${args.shown.id} ${clipNoteTitle(args.shown.content, NUDGE_TITLE_MAX)}`
        : "";
    return `${counts}${oldest}${shown}`;
}
