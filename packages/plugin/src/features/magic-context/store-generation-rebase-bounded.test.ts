import { expect, test } from "bun:test";

import type { RawMessage } from "../../hooks/magic-context/read-session-raw";
import { Database } from "../../shared/sqlite";
import { ensureMessagesIndexed } from "./message-index";
import { runMigrations } from "./migrations";
import { initializeDatabase } from "./storage-db";
import {
    readCoordinateGeneration,
    rebaseSessionCoordinates,
    rebaseSessionCoordinatesAsync,
} from "./store-generation-rebase";

/**
 * The store-generation rebase runs inside the request path on the first
 * OpenCode 2 request of a session last served by OpenCode 1. On a session of a
 * few tens of thousands of messages it once took minutes: it read the whole
 * history twice, and it looked up the part tags of every joined message with a
 * separate LIKE scan over all of the session's tags, which made the work grow
 * with (joined messages x tags).
 *
 * These tests measure work, not wall-clock time: the number of history reads,
 * and the statements prepared and executed, on the same session shape at two
 * sizes. Doubling the session may double the number of rows written, but it
 * must not add a statement that has to be compiled, nor a query against the
 * tag or queue tables.
 */

const SESSION = "ses_bounded";

interface Counters {
    prepared: number;
    executed: number;
    tagReads: number;
    queueReads: number;
}

/** Wrap one connection so every prepare and statement execution is counted. */
function countStatements(db: Database): Counters {
    const counters: Counters = { prepared: 0, executed: 0, tagReads: 0, queueReads: 0 };
    const prepare = db.prepare.bind(db);
    (db as unknown as { prepare: (sql: string) => unknown }).prepare = (sql: string) => {
        counters.prepared += 1;
        const statement = prepare(sql) as unknown as Record<
            string,
            (...args: unknown[]) => unknown
        >;
        const normalized = sql.replace(/\s+/g, " ").trim().toUpperCase();
        const readsTags = normalized.startsWith("SELECT") && / FROM TAGS\b/.test(normalized);
        const readsQueue =
            normalized.startsWith("SELECT") && / FROM PENDING_OPS\b/.test(normalized);
        return new Proxy(statement, {
            get(target, property, receiver) {
                const value = Reflect.get(target, property, receiver);
                if (
                    typeof value === "function" &&
                    (property === "run" || property === "get" || property === "all")
                ) {
                    return (...args: unknown[]) => {
                        counters.executed += 1;
                        if (readsTags) counters.tagReads += 1;
                        if (readsQueue) counters.queueReads += 1;
                        return value.apply(target, args);
                    };
                }
                return typeof value === "function" ? value.bind(target) : value;
            },
        });
    };
    return counters;
}

interface Fixture {
    v1: RawMessage[];
    v2: RawMessage[];
    queuedDrops: number;
}

/**
 * `turns` user turns, each followed by two assistant turns. Every second user
 * turn had two text parts that the 2.x host joins into one, and every seventh
 * user turn gets a synthetic row split out after it, which moves all later
 * ordinals and so forces the compartments and the search index to be re-derived.
 */
function buildFixture(db: Database, turns: number): Fixture {
    const v1: RawMessage[] = [];
    const v2: RawMessage[] = [];
    db.prepare("INSERT INTO session_meta (session_id, harness) VALUES (?, 'opencode')").run(
        SESSION,
    );
    const insertTag = db.prepare(
        `INSERT INTO tags (session_id, message_id, type, status, byte_size, tag_number, harness, tool_owner_message_id)
         VALUES (?, ?, ?, 'active', 10, ?, 'opencode', ?)`,
    );
    const queueDrop = db.prepare(
        "INSERT INTO pending_ops (session_id, tag_id, operation, queued_at, harness) VALUES (?, ?, 'drop', 1, 'opencode')",
    );
    let tag = 0;
    let queuedDrops = 0;
    for (let turn = 0; turn < turns; turn += 1) {
        const joined = turn % 2 === 0;
        const userId = `msg_${String(turn).padStart(5, "0")}_u`;
        const texts = joined ? [`turn ${turn} first`, `turn ${turn} second`] : [`turn ${turn}`];
        v1.push({
            id: userId,
            role: "user",
            ordinal: v1.length + 1,
            parts: texts.map((text) => ({ type: "text", text })),
        });
        v2.push({
            id: userId,
            role: "user",
            ordinal: v2.length + 1,
            parts: [{ type: "text", text: texts.join("\n\n") }],
        });
        texts.forEach((_, part) => {
            // Half of the joined turns never tagged their first fragment, so the
            // surviving tag is re-keyed down; the rest fold into part 0.
            if (part === 0 && joined && turn % 4 === 0) return;
            tag += 1;
            insertTag.run(SESSION, `${userId}:p${part}`, "message", tag, null);
            if (part === 1 && turn % 8 === 2) {
                queueDrop.run(SESSION, tag);
                queuedDrops += 1;
            }
        });
        if (turn % 7 === 3) {
            const synthetic: RawMessage = {
                id: `${userId}_syn`,
                role: "user",
                ordinal: v2.length + 1,
                parts: [{ type: "text", text: "<system-reminder>note</system-reminder>" }],
            };
            Object.defineProperty(synthetic, "storeType", {
                value: "synthetic",
                enumerable: false,
            });
            v2.push(synthetic);
        }
        for (let reply = 0; reply < 2; reply += 1) {
            const id = `msg_${String(turn).padStart(5, "0")}_a${reply}`;
            const parts = [
                { type: "text", text: `answer ${turn}.${reply}` },
                {
                    type: "tool",
                    tool: "bash",
                    callID: `call_${id}`,
                    state: { status: "completed", output: "ok" },
                },
            ];
            v1.push({ id, role: "assistant", ordinal: v1.length + 1, parts });
            v2.push({ id, role: "assistant", ordinal: v2.length + 1, parts });
            tag += 1;
            insertTag.run(SESSION, `${id}:p0`, "message", tag, null);
            tag += 1;
            insertTag.run(SESSION, `call_${id}`, "tool", tag, id);
        }
    }
    const insertCompartment = db.prepare(
        `INSERT INTO compartments
            (session_id, sequence, start_message, end_message, start_message_id, end_message_id,
             title, content, importance, legacy, created_at, harness)
         VALUES (?, ?, ?, ?, ?, ?, 'compartment', 'summary', 50, 0, 1000, 'opencode')`,
    );
    // One compartment per turn, leaving the newest turn unsummarised.
    for (let turn = 0; turn < turns - 1; turn += 1) {
        const start = turn * 3 + 1;
        const end = start + 2;
        insertCompartment.run(SESSION, turn + 1, start, end, v1[start - 1]?.id, v1[end - 1]?.id);
    }
    db.prepare("UPDATE session_meta SET coordinate_generation = 'v1' WHERE session_id = ?").run(
        SESSION,
    );
    ensureMessagesIndexed(db, SESSION, () => v1);
    return { v1, v2, queuedDrops };
}

function measure(turns: number) {
    const db = new Database(":memory:");
    initializeDatabase(db);
    runMigrations(db);
    const { v2, queuedDrops } = buildFixture(db, turns);
    let reads = 0;
    const counters = countStatements(db);
    const outcome = rebaseSessionCoordinates({
        db,
        sessionId: SESSION,
        generation: "v2",
        readMessages: () => {
            reads += 1;
            return v2;
        },
    });
    const second = rebaseSessionCoordinates({
        db,
        sessionId: SESSION,
        generation: "v2",
        readMessages: () => {
            reads += 1;
            return v2;
        },
    });
    db.close();
    return { outcome, second, reads, counters, queuedDrops };
}

/** Pages of `size` messages that each take `delayMs` of synchronous work to produce. */
function* slowPages(
    messages: RawMessage[],
    size: number,
    delayMs: number,
): Generator<RawMessage[]> {
    for (let start = 0; start < messages.length; start += size) {
        const until = performance.now() + delayMs;
        while (performance.now() < until) {
            // Stands in for decoding a page of host rows.
        }
        yield messages.slice(start, start + size);
    }
}

test("the async rebase lets other work run while it reads the history, and matches the sync rows", async () => {
    const run = async (useAsync: boolean) => {
        const db = new Database(":memory:");
        initializeDatabase(db);
        runMigrations(db);
        const { v2 } = buildFixture(db, 60);
        let ticks = 0;
        let readFinished = false;
        let stampedBeforeReadFinished = false;
        const timer = setInterval(() => {
            ticks += 1;
            if (!readFinished && readCoordinateGeneration(db, SESSION) === "v2") {
                stampedBeforeReadFinished = true;
            }
        }, 1);
        const args = {
            db,
            sessionId: SESSION,
            generation: "v2" as const,
            readMessages: () => v2,
            readMessagePages: function* () {
                yield* slowPages(v2, 10, 25);
                readFinished = true;
            },
        };
        const outcome = useAsync
            ? await rebaseSessionCoordinatesAsync(args)
            : rebaseSessionCoordinates(args);
        clearInterval(timer);
        const rows = ["compartments", "tags", "pending_ops", "message_history_source"].map(
            (table) =>
                db
                    .prepare(`SELECT * FROM ${table} WHERE session_id = ? ORDER BY 1`)
                    .all(SESSION)
                    .map((row) => {
                        const {
                            updated_at: _ignored,
                            queued_at: _alsoIgnored,
                            ...kept
                        } = row as Record<string, unknown>;
                        return kept;
                    }),
        );
        db.close();
        return { outcome, ticks, stampedBeforeReadFinished, rows };
    };
    const sync = await run(false);
    const sliced = await run(true);
    expect(sliced.outcome.status).toBe("rebased");
    expect(sliced.rows).toEqual(sync.rows);
    // The synchronous form holds the thread for the whole read; the async one
    // gives it up between pages, and the stamp is not visible before the
    // history read completes.
    expect(sync.ticks).toBe(0);
    expect(sliced.ticks).toBeGreaterThan(3);
    expect(sliced.stampedBeforeReadFinished).toBe(false);
});

test("two async rebases of one session run one after the other and the second finds it stamped", async () => {
    const db = new Database(":memory:");
    initializeDatabase(db);
    runMigrations(db);
    const { v2 } = buildFixture(db, 30);
    let reads = 0;
    const args = {
        db,
        sessionId: SESSION,
        generation: "v2" as const,
        readMessages: () => v2,
        readMessagePages: () => {
            reads += 1;
            return slowPages(v2, 10, 10);
        },
    };
    const [first, second] = await Promise.all([
        rebaseSessionCoordinatesAsync(args),
        rebaseSessionCoordinatesAsync(args),
    ]);
    db.close();
    expect(first.status).toBe("rebased");
    expect(second.status).toBe("unchanged");
    expect(reads).toBe(1);
});

test("a rebase that rebuilds the index reads the history once", () => {
    const { outcome, second, reads } = measure(40);
    expect(outcome.status).toBe("rebased");
    expect(outcome.indexRebuilt).toBe(true);
    expect(outcome.partTagsFolded).toBeGreaterThan(0);
    expect(outcome.partTagsRekeyed).toBeGreaterThan(0);
    expect(second.status).toBe("unchanged");
    expect(reads).toBe(1);
});

test("doubling the session adds no tag lookups, no statement compilations and no queue lookups beyond one per queued operation", () => {
    const small = measure(40);
    const large = measure(80);
    // The fixture really does grow in every dimension the rebase walks.
    expect(large.outcome.compartmentsRebased).toBeGreaterThan(small.outcome.compartmentsRebased);
    expect(large.outcome.partTagsFolded).toBeGreaterThan(small.outcome.partTagsFolded);
    expect(large.outcome.partTagsRekeyed).toBeGreaterThan(small.outcome.partTagsRekeyed);
    expect(large.outcome.indexRowsRebuilt).toBeGreaterThan(small.outcome.indexRowsRebuilt);

    expect(large.counters.tagReads).toBe(small.counters.tagReads);
    // A folded tag with a queued operation has that operation moved, which is
    // one lookup per queued operation. Tags with nothing queued cost none.
    expect(large.queuedDrops).toBeGreaterThan(small.queuedDrops);
    for (const run of [small, large]) {
        expect(run.counters.queueReads).toBeLessThanOrEqual(run.queuedDrops + 1);
    }
    expect(large.counters.prepared).toBe(small.counters.prepared);
    // Row writes scale with the session; nothing else may.
    expect(large.counters.executed).toBeLessThanOrEqual(small.counters.executed * 2 + 20);
});
