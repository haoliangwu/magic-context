import type { StoreRow, V2StoreReader } from "../store-reader";

/** The reader surface the restore needs: 100-row pages plus undecoded per-row stamps. */
export type RestoreRowReader = Pick<V2StoreReader, "page" | "spanRowStamps">;

interface KeptRow {
    stamp: string;
    row: StoreRow;
}

/**
 * Keeps the rows an OpenCode 2 host checkpoint hid from the context draft, so each
 * pass decodes only the rows it has not seen yet.
 *
 * After a host checkpoint the draft starts at the checkpoint, and every pass has to put
 * back the rows between the last Magic Context boundary and the checkpoint. With no
 * boundary yet (a long session before its first compartment) that span is the whole
 * history before the checkpoint, and reading it again on every pass decoded the whole
 * session every turn. Instead each pass reads one stamp per row of the span, without
 * decoding anything (id, update time and data size, see `spanRowStamps`), reuses every
 * kept row whose stamp is unchanged, and decodes only the rows that are new or whose
 * stamp changed, in 100-row pages. A row the host deleted is simply absent from the
 * stamps, and a row it rewrote in place to a different size or with a new update time
 * is read again, so the rows handed back are the rows a full read would return and what
 * the transform serves does not change.
 */
export class RestoredRowCache {
    private readonly sessions = new Map<string, Map<number, KeptRow>>();

    constructor(private readonly capacity = 16) {}

    /** Rows with `after < seq <= through`, ascending by seq. */
    rows(reader: RestoreRowReader, sessionID: string, after: number, through: number): StoreRow[] {
        if (through <= after) return [];
        const kept = this.sessions.get(sessionID) ?? new Map<number, KeptRow>();
        const stamps = reader.spanRowStamps(sessionID, after, through);
        // Runs of consecutive span rows that must be decoded, each as the exclusive seq
        // cursor before the run and the last seq in it.
        const runs: Array<{ after: number; through: number }> = [];
        let previous = after;
        let open: { after: number; through: number } | undefined;
        for (const [seq, stamp] of stamps) {
            if (kept.get(seq)?.stamp === stamp) {
                open = undefined;
            } else if (open) {
                open.through = seq;
            } else {
                open = { after: previous, through: seq };
                runs.push(open);
            }
            previous = seq;
        }
        const fresh = new Map<number, StoreRow>();
        for (const run of runs)
            for (const row of readPages(reader, sessionID, run.after, run.through))
                fresh.set(row.seq, row);
        const next = new Map<number, KeptRow>();
        const rows: StoreRow[] = [];
        for (const [seq, stamp] of stamps) {
            const row = fresh.get(seq) ?? kept.get(seq)?.row;
            if (!row) continue;
            next.set(seq, { stamp, row });
            rows.push(row);
        }
        this.sessions.delete(sessionID);
        this.sessions.set(sessionID, next);
        // Keep only the most recently restored sessions; an evicted one reads cold once.
        while (this.sessions.size > this.capacity) {
            const oldest = this.sessions.keys().next().value;
            if (oldest === undefined) break;
            this.sessions.delete(oldest);
        }
        // Restored messages share objects with their row's data, and the transform edits
        // the messages it is handed, so each pass gets its own copy of the kept rows.
        return structuredClone(rows);
    }

    forget(sessionID: string): void {
        this.sessions.delete(sessionID);
    }

    clear(): void {
        this.sessions.clear();
    }
}

function readPages(
    reader: RestoreRowReader,
    sessionID: string,
    after: number,
    through: number,
): StoreRow[] {
    const rows: StoreRow[] = [];
    let cursor = after;
    while (cursor < through) {
        const page = reader.page(sessionID, { after: cursor, through, limit: 100 });
        rows.push(...page.rows);
        if (page.rows.length < 100 || page.cursor === undefined) break;
        cursor = page.cursor;
    }
    return rows;
}
