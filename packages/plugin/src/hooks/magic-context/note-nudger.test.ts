/// <reference types="bun-types" />

import { afterEach, describe, expect, it, setSystemTime } from "bun:test";
import {
    appendNoteNudgeAnchor,
    getNoteNudgeAnchors,
    setNoteLastReadAt,
} from "../../features/magic-context/storage-meta-persisted";
import { addNote } from "../../features/magic-context/storage-notes";
import { Database } from "../../shared/sqlite";
import { closeQuietly } from "../../shared/sqlite-helpers";
import {
    clearNoteNudgeState,
    clearNoteNudgeTriggerOnly,
    getNoteNudgeCooldownCountForTest,
    getNoteNudgeText,
    getStickyNoteNudge,
    markNoteNudgeDelivered,
    onNoteTrigger,
    peekNoteNudgeText,
    recordNoteNudgeDeliveryTime,
    resetNoteNudgeCooldownOnly,
} from "./note-nudger";

const dbs: Database[] = [];

afterEach(() => {
    for (const db of dbs) {
        closeQuietly(db);
    }
    dbs.length = 0;
});

function makeDb(): Database {
    const db = new Database(":memory:");
    db.exec(`
        CREATE TABLE session_meta (
            session_id TEXT PRIMARY KEY,
            last_response_time INTEGER DEFAULT 0,
            cache_ttl TEXT DEFAULT '5m',
            counter INTEGER DEFAULT 0,
            last_nudge_tokens INTEGER DEFAULT 0,
            last_nudge_band TEXT DEFAULT '',
            last_transform_error TEXT DEFAULT '',
            is_subagent INTEGER DEFAULT 0,
            last_context_percentage REAL DEFAULT 0,
            last_input_tokens INTEGER DEFAULT 0,
            observed_safe_input_tokens INTEGER NOT NULL DEFAULT 0,
            cache_alert_sent INTEGER NOT NULL DEFAULT 0,
            times_execute_threshold_reached INTEGER DEFAULT 0,
            compartment_in_progress INTEGER DEFAULT 0,
            historian_failure_count INTEGER DEFAULT 0,
            historian_last_error TEXT DEFAULT NULL,
            historian_last_failure_at INTEGER DEFAULT NULL,
            system_prompt_hash TEXT DEFAULT '',
            system_prompt_tokens INTEGER DEFAULT 0,
      conversation_tokens INTEGER DEFAULT 0,
      tool_call_tokens INTEGER DEFAULT 0,
            note_nudge_trigger_pending INTEGER DEFAULT 0,
            note_nudge_trigger_message_id TEXT DEFAULT '',
            note_nudge_sticky_text TEXT DEFAULT '',
            note_nudge_sticky_message_id TEXT DEFAULT '',
            note_nudge_anchors TEXT NOT NULL DEFAULT '[]',
            auto_search_hint_decisions TEXT NOT NULL DEFAULT '[]',
            note_last_read_at INTEGER DEFAULT 0,
            cleared_reasoning_through_tag INTEGER DEFAULT 0,
      harness TEXT NOT NULL DEFAULT 'opencode'
    );

        CREATE TABLE notes (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            type TEXT NOT NULL DEFAULT 'session',
            status TEXT NOT NULL DEFAULT 'active',
            content TEXT NOT NULL,
            session_id TEXT,
            project_path TEXT,
            surface_condition TEXT,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            last_checked_at INTEGER,
            ready_at INTEGER,
            ready_reason TEXT,
      harness TEXT NOT NULL DEFAULT 'opencode',
      anchor_ordinal INTEGER
    );
    `);
    dbs.push(db);
    return db;
}

function getPersistedRow(db: Database, sessionId: string) {
    return db
        .prepare(
            "SELECT note_nudge_trigger_pending AS triggerPending, note_nudge_trigger_message_id AS triggerMessageId, note_nudge_sticky_text AS stickyText, note_nudge_sticky_message_id AS stickyMessageId FROM session_meta WHERE session_id = ?",
        )
        .get(sessionId) as {
        triggerPending: number;
        triggerMessageId: string;
        stickyText: string;
        stickyMessageId: string;
    } | null;
}

describe("note-nudger", () => {
    it("persists trigger deferral and sticky delivery state in session_meta", () => {
        const db = makeDb();
        addNote(db, "session", { sessionId: "ses-trigger", content: "Follow up later." });

        onNoteTrigger(db, "ses-trigger", "historian_complete");

        expect(peekNoteNudgeText(db, "ses-trigger", "u-1")).toBeNull();
        expect(getPersistedRow(db, "ses-trigger")).toEqual({
            triggerPending: 1,
            triggerMessageId: "u-1",
            stickyText: "",
            stickyMessageId: "",
        });

        const text = peekNoteNudgeText(db, "ses-trigger", "u-2");
        expect(text).toContain("0 notes ready, 1 active");
        expect(text).toContain("#1 Follow up later.");

        markNoteNudgeDelivered(db, "ses-trigger", text!, "u-2");

        expect(getPersistedRow(db, "ses-trigger")).toEqual({
            triggerPending: 0,
            triggerMessageId: "",
            stickyText: "",
            stickyMessageId: "",
        });
        expect(getNoteNudgeAnchors(db, "ses-trigger")).toEqual([{ messageId: "u-2", text: text! }]);
        expect(getStickyNoteNudge(db, "ses-trigger")).toBeNull();
        expect(peekNoteNudgeText(db, "ses-trigger", "u-3")).toBeNull();
    });

    it("returns null when no notes exist even if triggered", () => {
        const db = makeDb();

        onNoteTrigger(db, "ses-empty", "todos_complete");

        expect(getNoteNudgeText(db, "ses-empty")).toBeNull();
    });

    it("suppresses nudge when agent ran ctx_note(read) AND that read is still visible in context", () => {
        const db = makeDb();
        const note = addNote(db, "session", {
            sessionId: "ses-read-watermark",
            content: "Already-seen note.",
        });

        // Simulate agent running ctx_note(read) shortly after the note was added.
        setNoteLastReadAt(db, "ses-read-watermark", note.updatedAt + 1000);

        onNoteTrigger(db, "ses-read-watermark", "commit_detected");
        // First peek records the trigger-time message so it gets deferred.
        expect(peekNoteNudgeText(db, "ses-read-watermark", "u-1", undefined, true)).toBeNull();
        // Subsequent peek on a new user message: the read watermark is newer
        // than all note activity AND the read is still visible → suppress.
        expect(peekNoteNudgeText(db, "ses-read-watermark", "u-2", undefined, true)).toBeNull();
    });

    it("re-nudges after work boundary when prior ctx_note(read) is no longer visible (dropped/aged/reduced)", () => {
        const db = makeDb();
        const note = addNote(db, "session", {
            sessionId: "ses-read-dropped",
            content: "Note the agent already saw but read got dropped.",
        });

        // Agent ran ctx_note(read) — watermark advances past note activity.
        setNoteLastReadAt(db, "ses-read-dropped", note.updatedAt + 1000);

        // A work-boundary trigger fires (commit/historian/todos).
        onNoteTrigger(db, "ses-read-dropped", "historian_complete");
        // Defer first peek (trigger-time message).
        expect(peekNoteNudgeText(db, "ses-read-dropped", "u-1", undefined, false)).toBeNull();
        // Subsequent peek: read watermark is newer than note activity, BUT the
        // read is NO LONGER visible (compactified, ctx_reduce'd, or aged out).
        // The agent has lost note visibility, so re-surface the reminder.
        expect(peekNoteNudgeText(db, "ses-read-dropped", "u-2", undefined, false)).toContain(
            "0 notes ready, 1 active",
        );
    });

    it("still delivers when a new note arrives after the last ctx_note(read)", () => {
        const db = makeDb();
        const older = addNote(db, "session", {
            sessionId: "ses-new-activity",
            content: "Old note already seen.",
        });

        // Agent read notes right after the older note was written, well before
        // the new note arrived. Use a small forward jump so real-world clocks
        // can't accidentally push a same-millisecond `addNote` past this mark.
        const readAt = older.updatedAt + 1;
        setNoteLastReadAt(db, "ses-new-activity", readAt);

        // A new note must land strictly after the recorded read watermark.
        // `addNote` uses `Date.now()` which may share a millisecond with the
        // first insert on fast hardware, so stamp its timestamps explicitly.
        const newerAt = readAt + 1;
        db.prepare(
            `INSERT INTO notes (type, status, content, session_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`,
        ).run(
            "session",
            "active",
            "New note after last read.",
            "ses-new-activity",
            newerAt,
            newerAt,
        );

        onNoteTrigger(db, "ses-new-activity", "historian_complete");
        // Defer first peek (trigger-time message).
        expect(peekNoteNudgeText(db, "ses-new-activity", "u-1")).toBeNull();
        // On the next user message, the nudge fires because one note is newer
        // than the last read watermark.
        expect(peekNoteNudgeText(db, "ses-new-activity", "u-2")).toContain(
            "0 notes ready, 2 active",
        );
    });

    it("clears persisted state so prior triggers and stickies no longer produce nudges", () => {
        const db = makeDb();
        addNote(db, "session", { sessionId: "ses-clear", content: "Circle back." });

        onNoteTrigger(db, "ses-clear", "historian_complete");
        const text = peekNoteNudgeText(db, "ses-clear", "u-2");
        markNoteNudgeDelivered(db, "ses-clear", text!, "u-2");

        clearNoteNudgeState(db, "ses-clear");

        expect(getPersistedRow(db, "ses-clear")).toEqual({
            triggerPending: 0,
            triggerMessageId: "",
            stickyText: "",
            stickyMessageId: "",
        });
        expect(getStickyNoteNudge(db, "ses-clear")).toBeNull();
        expect(getNoteNudgeText(db, "ses-clear")).toBeNull();

        onNoteTrigger(db, "ses-clear", "todos_complete");

        expect(getNoteNudgeText(db, "ses-clear")).toContain("0 notes ready, 1 active");
    });

    it("suppresses a later trigger inside the cooldown window whichever arm fired it", () => {
        const db = makeDb();
        addNote(db, "session", { sessionId: "ses-cooldown", content: "Circle back." });

        onNoteTrigger(db, "ses-cooldown", "todos_complete");
        expect(peekNoteNudgeText(db, "ses-cooldown", "u-1")).toBeNull();
        const text = peekNoteNudgeText(db, "ses-cooldown", "u-2");
        expect(text).toContain("0 notes ready, 1 active");
        markNoteNudgeDelivered(db, "ses-cooldown", text!, "u-2");

        // A second work boundary — here the historian-publish arm, which rust mode also
        // uses — lands inside the 15-minute window, so the peek consumes the trigger
        // instead of nudging again.
        onNoteTrigger(db, "ses-cooldown", "historian_complete");
        expect(peekNoteNudgeText(db, "ses-cooldown", "u-3")).toBeNull();
        expect(peekNoteNudgeText(db, "ses-cooldown", "u-4")).toBeNull();
        expect(getPersistedRow(db, "ses-cooldown")?.triggerPending).toBe(0);

        // With the window expired, the same arm delivers again — the suppression above
        // was the cooldown and nothing else.
        onNoteTrigger(db, "ses-cooldown", "historian_complete");
        resetNoteNudgeCooldownOnly("ses-cooldown");
        expect(peekNoteNudgeText(db, "ses-cooldown", "u-5")).toBeNull();
        expect(peekNoteNudgeText(db, "ses-cooldown", "u-6")).toContain("0 notes ready, 1 active");
    });

    it("shows a different note on each delivery and replays a delivery byte-identically", () => {
        const db = makeDb();
        const sessionId = "ses-pick";
        for (const content of [
            "First deferred item",
            "Second deferred item",
            "Third deferred item",
        ]) {
            addNote(db, "session", { sessionId, content });
        }

        // Two consecutive deliveries: each is a fresh trigger after the
        // previous one was marked delivered, so the pick counter advances.
        onNoteTrigger(db, sessionId, "historian_complete");
        expect(peekNoteNudgeText(db, sessionId, "u-1")).toBeNull();
        const first = peekNoteNudgeText(db, sessionId, "u-2");
        expect(first).not.toBeNull();
        markNoteNudgeDelivered(db, sessionId, first!, "u-2");

        resetNoteNudgeCooldownOnly(sessionId);
        onNoteTrigger(db, sessionId, "todos_complete");
        expect(peekNoteNudgeText(db, sessionId, "u-3")).toBeNull();
        const second = peekNoteNudgeText(db, sessionId, "u-4");
        expect(second).not.toBeNull();
        markNoteNudgeDelivered(db, sessionId, second!, "u-4");

        expect(second).not.toBe(first);

        // Replay: the delivered text is stored with its anchor, so every later
        // pass re-injects exactly the bytes that were delivered.
        const anchors = getNoteNudgeAnchors(db, sessionId);
        expect(anchors).toEqual([
            { messageId: "u-2", text: first! },
            { messageId: "u-4", text: second! },
        ]);
        expect(getStickyNoteNudge(db, sessionId)).toBeNull();
    });

    it("shows a ready smart note instead of the random pick when one exists", () => {
        const db = makeDb();
        const sessionId = "ses-ready-pick";
        addNote(db, "session", { sessionId, content: "Plain deferred item" });
        db.prepare(
            `INSERT INTO notes (type, status, content, project_path, surface_condition, created_at, updated_at, ready_at)
             VALUES ('smart', 'ready', ?, 'git:project-a', 'condition', 1, 1, 1)`,
        ).run("Ready smart item");

        onNoteTrigger(db, sessionId, "historian_complete");
        expect(peekNoteNudgeText(db, sessionId, "u-1", "git:project-a")).toBeNull();
        const text = peekNoteNudgeText(db, sessionId, "u-2", "git:project-a");

        expect(text).toContain("1 notes ready, 1 active");
        expect(text).toContain("#2 Ready smart item");
        expect(text).not.toContain("Plain deferred item");
    });

    it("clearNoteNudgeTriggerOnly preserves delivered anchors", () => {
        const db = makeDb();
        appendNoteNudgeAnchor(db, "ses-trigger-only", "m1", "one");
        appendNoteNudgeAnchor(db, "ses-trigger-only", "m2", "two");
        onNoteTrigger(db, "ses-trigger-only", "todos_complete");

        clearNoteNudgeTriggerOnly(db, "ses-trigger-only");

        expect(getPersistedRow(db, "ses-trigger-only")?.triggerPending).toBe(0);
        expect(getPersistedRow(db, "ses-trigger-only")?.triggerMessageId).toBe("");
        expect(getNoteNudgeAnchors(db, "ses-trigger-only")).toEqual([
            { messageId: "m1", text: "one" },
            { messageId: "m2", text: "two" },
        ]);
    });

    it("drops cooldown entries once their window has passed instead of keeping one per session forever", () => {
        // Far ahead of the real clock, so entries other tests left behind count as expired.
        const start = new Date("2100-01-01T00:00:00Z").getTime();
        try {
            setSystemTime(start);
            for (let index = 0; index < 50; index += 1) {
                recordNoteNudgeDeliveryTime(`ses-cooldown-prune-${index}`);
            }
            expect(getNoteNudgeCooldownCountForTest()).toBeGreaterThanOrEqual(50);

            // Sixteen minutes later every earlier window has closed, so the next
            // delivery leaves only its own entry behind.
            setSystemTime(start + 16 * 60 * 1000);
            recordNoteNudgeDeliveryTime("ses-cooldown-prune-late");
            expect(getNoteNudgeCooldownCountForTest()).toBe(1);
        } finally {
            setSystemTime();
            resetNoteNudgeCooldownOnly("ses-cooldown-prune-late");
        }
    });
});
