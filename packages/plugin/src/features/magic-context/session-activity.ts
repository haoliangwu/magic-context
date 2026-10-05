import type { Database } from "../../shared/sqlite";

// context.db already has this key/value table. A session's project binding can
// change without any new messages, so its timestamp cannot represent activity.
// Reusing the table also avoids a database migration.
const PREFIX = "retrospective_activity:";
const INTERVAL_MS = 15_000;
const pending = new WeakMap<
    Database,
    Map<string, { lastWrite: number; latest: number; timer?: ReturnType<typeof setTimeout> }>
>();

export function sessionActivityKey(sessionId: string): string {
    return `${PREFIX}${sessionId}`;
}

export function deleteSessionActivity(db: Database, sessionIds: readonly string[]): void {
    if (sessionIds.length === 0) return;
    const sessions = pending.get(db);
    for (const sessionId of sessionIds) {
        const state = sessions?.get(sessionId);
        if (state?.timer) clearTimeout(state.timer);
        sessions?.delete(sessionId);
    }
    const placeholders = sessionIds.map(() => "?").join(", ");
    db.prepare(`DELETE FROM schema_migrations_meta WHERE key IN (${placeholders})`).run(
        ...sessionIds.map(sessionActivityKey),
    );
}

export function readSessionActivity(db: Database, sessionId: string): number | undefined {
    const row = db
        .prepare("SELECT value FROM schema_migrations_meta WHERE key = ?")
        .get(sessionActivityKey(sessionId)) as { value: string } | undefined;
    const time = Number(row?.value);
    return row && Number.isFinite(time) ? time : undefined;
}

export function advanceSessionActivity(db: Database, sessionId: string, time: number): void {
    if (!sessionId || !Number.isFinite(time) || time <= 0) return;
    db.prepare(`INSERT INTO schema_migrations_meta (key, value) VALUES (?, ?)
        ON CONFLICT(key) DO UPDATE SET value = CAST(MAX(CAST(value AS INTEGER), CAST(excluded.value AS INTEGER)) AS TEXT)`).run(
        sessionActivityKey(sessionId),
        String(Math.floor(time)),
    );
}

/** Persist the first event immediately and fold subsequent events into one trailing write. */
export function observeSessionActivity(db: Database, sessionId: string, time = Date.now()): void {
    if (!sessionId || !Number.isFinite(time) || time <= 0) return;
    let sessions = pending.get(db);
    if (!sessions) {
        sessions = new Map();
        pending.set(db, sessions);
    }
    const current = sessions.get(sessionId);
    if (!current || time - current.lastWrite >= INTERVAL_MS) {
        if (current?.timer) clearTimeout(current.timer);
        advanceSessionActivity(db, sessionId, Math.max(time, current?.latest ?? 0));
        sessions.set(sessionId, { lastWrite: time, latest: time });
        return;
    }
    current.latest = Math.max(current.latest, time);
    if (!current.timer) {
        current.timer = setTimeout(
            () => {
                current.timer = undefined;
                try {
                    advanceSessionActivity(db, sessionId, current.latest);
                    current.lastWrite = Date.now();
                } catch {
                    // A closed connection cannot be flushed; the next host event retries.
                    sessions.delete(sessionId);
                }
            },
            Math.max(1, INTERVAL_MS - (time - current.lastWrite)),
        );
        current.timer.unref?.();
    }
}

/** One bounded page at a time; failed scans remain retryable on the next startup. */
export async function backfillSessionActivity(
    db: Database,
    harness: string,
    latestTime: (sessionId: string) => number | undefined | Promise<number | undefined>,
): Promise<void> {
    const completedKey = `retrospective_activity_backfill:${harness}:v1`;
    if (db.prepare("SELECT 1 FROM schema_migrations_meta WHERE key = ?").get(completedKey)) return;
    let cursor = "";
    while (true) {
        const rows = db
            .prepare(`SELECT session_id FROM session_projects
            WHERE harness = ? AND session_id > ? ORDER BY session_id LIMIT 100`)
            .all(harness, cursor) as Array<{ session_id: string }>;
        if (rows.length === 0) break;
        for (const row of rows) {
            const time = await latestTime(row.session_id);
            if (time !== undefined) advanceSessionActivity(db, row.session_id, time);
        }
        cursor = rows[rows.length - 1].session_id;
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
    db.prepare(
        "INSERT OR IGNORE INTO schema_migrations_meta (key, value) VALUES (?, 'completed')",
    ).run(completedKey);
}
