/// <reference types="bun-types" />
/**
 * Store-backed compartment boundary resolution must give exactly the answer
 * the earlier per-endpoint reader gave. That reader is frozen below as
 * `legacyResolve`, built from the unchanged single-message readers, and every
 * scenario compares the two, including after host-store writes that the
 * boundary cache must notice.
 */
import { afterEach, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { appendCompartments } from "../../features/magic-context/compartment-storage";
import { runMigrations } from "../../features/magic-context/migrations";
import { initializeDatabase } from "../../features/magic-context/storage-db";
import { Database } from "../../shared/sqlite";
import { createTestTempDirFromPath } from "../../shared/test-temp-dir";
import { moduleRawBlockMappings } from "./module-wire";
import { closeReadOnlySessionDb } from "./read-session-db";
import {
    getRawBoundaryEndpointRowsReadForTest,
    readRawSessionBoundaryEndpointsFromDb,
    readRawSessionMessageIdOrdinalsForRangeFromDb,
    readRawSessionMessagePartsByIdFromDb,
    resetRawBoundaryEndpointRowsReadForTest,
} from "./read-session-raw";
import {
    type ResolvedContextBoundary,
    resolveSharedCompartmentBoundaries,
    SharedCompartmentBoundaryError,
} from "./shared-compartment-boundaries";
import { formatDate } from "./temporal-awareness";

const SESSION = "ses-boundary-store";
const originalXdgDataHome = process.env.XDG_DATA_HOME;
const cleanup: Array<() => void> = [];

afterEach(() => {
    for (const close of cleanup.splice(0).reverse()) close();
    closeReadOnlySessionDb();
    if (originalXdgDataHome === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = originalXdgDataHome;
});

interface FixtureMessage {
    id: string;
    time: number;
    /** Raw message JSON; malformed text is allowed. */
    data: string;
    session?: string;
    /** Raw part JSON strings; malformed text is allowed. */
    parts?: string[];
}

const info = (role: string, extra: Record<string, unknown> = {}) =>
    JSON.stringify({ role, ...extra });
const part = (value: unknown) => JSON.stringify(value);

/** Every part shape moduleRawBlockMappings distinguishes. */
const PART_CATALOGUE: string[] = [
    part({ type: "text", text: "visible" }),
    part({ type: "text", text: "hidden", ignored: true }),
    part({ type: "text", text: "string flag", ignored: "true" }),
    part({ type: "reasoning", text: "r" }),
    part({ type: "thinking", text: "t" }),
    part({ type: "tool", callID: "c1", state: { status: "completed", input: {}, output: "o" } }),
    part({ type: "tool", callID: "c2", state: { status: "error", input: {}, error: "e" } }),
    part({ type: "tool", callID: "c3", state: { status: "running", input: {} } }),
    part({ type: "tool", callID: "c4", state: [] }),
    part({ type: "tool", callID: "c5", state: { status: 1 } }),
    part({ type: "tool", callID: "c6" }),
    part({ type: "file", url: "file:///x" }),
    part({ type: "image" }),
    part({ type: "step-start" }),
    part({ type: "subtask" }),
    part({ type: "compaction" }),
    part({ type: "step-finish" }),
    part({ type: "snapshot" }),
    part({ type: "patch" }),
    part({ type: "agent" }),
    part({ type: "retry" }),
    part({ type: "custom-kind" }),
    part({ type: 7 }),
    part({ text: "no type" }),
    part(["array part"]),
    part("string part"),
    part(null),
    "{not json",
];

/**
 * Shapes only the per-shape block test uses, so a miscount of one of them
 * shows up in that test alone.
 */
const PER_SHAPE_ONLY: string[] = [part({ type: "redacted_thinking", data: "x" })];

function writeStore(path: string, messages: readonly FixtureMessage[]): void {
    mkdirSync(dirname(path), { recursive: true });
    rmSync(path, { force: true });
    const db = new Database(path);
    try {
        db.exec(`
            CREATE TABLE session (id TEXT PRIMARY KEY);
            CREATE TABLE message (id text PRIMARY KEY, session_id text NOT NULL, time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL);
            CREATE TABLE part (id text PRIMARY KEY, message_id text NOT NULL, session_id text NOT NULL, time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL);
            CREATE INDEX message_session_time_created_id_idx ON message(session_id, time_created, id);
            CREATE INDEX part_message_id_id_idx ON part(message_id, id);
            CREATE INDEX part_session_idx ON part(session_id);
        `);
        for (const message of messages) insertMessage(db, message);
        // A part another session owns on a boundary message id must not count.
        db.prepare("INSERT INTO part VALUES ('foreign', 'a1', 'ses-other', 0, 0, ?)").run(
            part({ type: "text", text: "foreign" }),
        );
    } finally {
        db.close();
    }
}

let partSequence = 0;
function insertMessage(db: Database, message: FixtureMessage): void {
    const session = message.session ?? SESSION;
    db.prepare("INSERT INTO message VALUES (?, ?, ?, ?, ?)").run(
        message.id,
        session,
        message.time,
        message.time,
        message.data,
    );
    for (const data of message.parts ?? []) {
        partSequence += 1;
        db.prepare("INSERT INTO part VALUES (?, ?, ?, ?, ?, ?)").run(
            `prt_${String(partSequence).padStart(6, "0")}`,
            message.id,
            session,
            message.time,
            message.time,
            data,
        );
    }
}

function useStore(messages: readonly FixtureMessage[]): string {
    const dir = createTestTempDirFromPath(join(tmpdir(), "boundary-store-"));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    process.env.XDG_DATA_HOME = dir;
    const path = join(dir, "opencode", "opencode.db");
    writeStore(path, messages);
    return path;
}

function contextDb(): Database {
    const db = new Database(":memory:");
    initializeDatabase(db);
    runMigrations(db);
    cleanup.push(() => db.close());
    return db;
}

interface Row {
    start: string;
    end: string;
    startBlock?: number | null;
    endBlock?: number | null;
}

function addCompartments(db: Database, rows: readonly Row[], firstSequence = 0): void {
    appendCompartments(
        db,
        SESSION,
        rows.map((row, index) => ({
            sequence: firstSequence + index,
            startMessage: firstSequence + index + 1,
            endMessage: firstSequence + index + 1,
            startMessageId: row.start,
            endMessageId: row.end,
            startBlockIndex: row.startBlock ?? null,
            endBlockIndex: row.endBlock ?? null,
            title: `c${firstSequence + index}`,
            content: "summary",
        })),
    );
}

/**
 * Reference copy of the earlier resolver, which read every endpoint with
 * readRawSessionMessagePartsByIdFromDb and the whole ordinal map with
 * readRawSessionMessageIdOrdinalsForRangeFromDb. Its logic is unchanged; only
 * those two readers are called directly on a store connection.
 */
function legacyResolve(
    db: Database,
    store: Database,
    sessionId: string,
): ResolvedContextBoundary[] {
    const rows = db
        .prepare(
            "SELECT sequence, start_message, end_message, COALESCE(start_message_id, '') AS start_message_id, COALESCE(end_message_id, '') AS end_message_id, start_block_index, end_block_index FROM compartments WHERE session_id=? ORDER BY sequence",
        )
        .all(sessionId) as Array<{
        sequence: number;
        start_message: number;
        end_message: number;
        start_message_id: string;
        end_message_id: string;
        start_block_index: number | null;
        end_block_index: number | null;
    }>;
    if (rows.every((row) => row.start_block_index !== null && row.end_block_index !== null))
        return [];
    const ordinals = readRawSessionMessageIdOrdinalsForRangeFromDb(
        store,
        sessionId,
        1,
        Number.MAX_SAFE_INTEGER,
    );
    const rawById = new Map<string, ReturnType<typeof readRawSessionMessagePartsByIdFromDb>>();
    const endpoint = (rawId: string, blockIndex: number | null, edge: "start" | "end") => {
        if (!rawById.has(rawId))
            rawById.set(rawId, readRawSessionMessagePartsByIdFromDb(store, sessionId, rawId));
        const raw = rawById.get(rawId) ?? null;
        const ordinal = raw?.id === rawId ? (ordinals.get(rawId) ?? null) : null;
        const block =
            blockIndex !== null
                ? blockIndex
                : edge === "start"
                  ? 0
                  : (moduleRawBlockMappings(raw).at(-1)?.blockIndex ?? 0);
        return { ordinal, id: `${rawId}#${block}`, raw };
    };
    const idsByOrdinal = rows.some((row) => !row.start_message_id || !row.end_message_id)
        ? new Map([...ordinals].map(([id, ordinal]) => [ordinal, id]))
        : null;
    const endpoints = rows.map((row) => ({
        start: endpoint(row.start_message_id, row.start_block_index, "start"),
        end: endpoint(row.end_message_id, row.end_block_index, "end"),
    }));
    return rows.map((row, index) => {
        let { start, end } = endpoints[index];
        let startOrdinal = start.ordinal;
        let endOrdinal = end.ordinal;
        if (startOrdinal !== null || endOrdinal !== null) {
            if (startOrdinal === null) {
                const previousEnd = endpoints[index - 1]?.end.ordinal;
                startOrdinal =
                    typeof previousEnd === "number"
                        ? previousEnd + 1
                        : index === 0
                          ? (readRawSessionMessageIdOrdinalsForRangeFromDb(store, sessionId, 1, 1)
                                .values()
                                .next().value ?? null)
                          : null;
            }
            if (endOrdinal === null) {
                const nextStart = endpoints[index + 1]?.start.ordinal;
                endOrdinal = typeof nextStart === "number" ? nextStart - 1 : null;
            }
        }
        if (
            startOrdinal === null ||
            endOrdinal === null ||
            startOrdinal < 1 ||
            startOrdinal > endOrdinal
        ) {
            throw new SharedCompartmentBoundaryError(sessionId, row.sequence);
        }
        const resolveMissingId = (
            sourceId: string,
            blockIndex: number | null,
            ordinal: number,
            edge: "start" | "end",
        ) => {
            const id = idsByOrdinal?.get(ordinal);
            if (sourceId || blockIndex !== null || !id)
                throw new SharedCompartmentBoundaryError(sessionId, row.sequence);
            return endpoint(id, null, edge);
        };
        if (!row.start_message_id)
            start = resolveMissingId(
                row.start_message_id,
                row.start_block_index,
                startOrdinal,
                "start",
            );
        if (!row.end_message_id)
            end = resolveMissingId(row.end_message_id, row.end_block_index, endOrdinal, "end");
        const dates =
            typeof start.raw?.createdAt === "number" && typeof end.raw?.createdAt === "number"
                ? {
                      start_date: formatDate(start.raw.createdAt),
                      end_date: formatDate(end.raw.createdAt),
                  }
                : { start_date: null, end_date: null };
        return {
            sequence: row.sequence,
            source_start_message: row.start_message,
            source_end_message: row.end_message,
            source_start_message_id: row.start_message_id,
            source_start_block_index: row.start_block_index,
            source_end_message_id: row.end_message_id,
            source_end_block_index: row.end_block_index,
            start_message: startOrdinal,
            end_message: endOrdinal,
            start_message_id: start.id,
            end_message_id: end.id,
            ...dates,
        };
    });
}

function outcome(run: () => ResolvedContextBoundary[]): unknown {
    try {
        return { resolved: run() };
    } catch (error) {
        return { error: error instanceof Error ? error.message : String(error) };
    }
}

function expectSameAsLegacy(db: Database, storePath: string): unknown {
    const store = new Database(storePath, { readonly: true });
    try {
        const expected = outcome(() => legacyResolve(db, store, SESSION));
        expect(outcome(() => resolveSharedCompartmentBoundaries(db, SESSION))).toEqual(expected);
        return expected;
    } finally {
        store.close();
    }
}

/**
 * A session covering every row kind the resolver treats differently: other
 * sessions' rows, finished and unfinished compaction summaries (which do or do
 * not take an ordinal), numeric summary flags, malformed or non-object info
 * (which take an ordinal but can never be a resolved endpoint), timestamp ties,
 * and messages with no parts.
 */
function edgeCaseMessages(): FixtureMessage[] {
    let time = 1_760_000_000_000;
    const at = (step = 1000) => {
        time += step;
        return time;
    };
    return [
        { id: "u1", time: at(), data: info("user"), parts: [part({ type: "text", text: "q1" })] },
        { id: "a1", time: at(), data: info("assistant"), parts: PART_CATALOGUE.slice(0, 8) },
        // Another session's row interleaves in time.
        { id: "x1", time: at(), data: info("user"), session: "ses-other", parts: [] },
        {
            id: "sum1",
            time: at(),
            data: info("assistant", { summary: true, finish: "stop" }),
            parts: [part({ type: "text", text: "summary" })],
        },
        { id: "u2", time: at(), data: info("user"), parts: PART_CATALOGUE.slice(0, 3) },
        { id: "a2", time: at(), data: info("assistant"), parts: PART_CATALOGUE.slice(8) },
        // A numeric summary flag is not a compaction summary in this ordinal space.
        {
            id: "num1",
            time: at(),
            data: info("assistant", { summary: 1, finish: "stop" }),
            parts: [part({ type: "reasoning", text: "r" })],
        },
        // Malformed info JSON takes an ordinal but is never servable.
        { id: "bad", time: at(), data: "{not json", parts: [part({ type: "text" })] },
        { id: "arr", time: at(), data: "[1,2]", parts: [] },
        // Same timestamp: order falls back to the id.
        { id: "a3z", time: at(), data: info("assistant"), parts: [] },
        { id: "a3a", time: time, data: info("assistant"), parts: PART_CATALOGUE.slice(20) },
        {
            id: "tlen",
            time: at(),
            data: info("assistant", { summary: true, finish: "length" }),
            parts: [part({ type: "text", text: "unfinished" })],
        },
        { id: "u3", time: at(), data: info("user"), parts: [part({ type: "text", text: "q3" })] },
        { id: "a4", time: at(), data: info("assistant"), parts: PART_CATALOGUE },
        { id: "u4", time: at(), data: info("user"), parts: [part({ type: "text", text: "q4" })] },
        { id: "a5", time: at(), data: info("assistant"), parts: [part({ type: "step-finish" })] },
        { id: "u5", time: at(), data: info("user"), parts: [part({ type: "text", text: "q5" })] },
    ];
}

const EDGE_ROWS: Row[] = [
    { start: "u1", end: "a1" },
    { start: "u2", end: "a2" },
    { start: "num1", end: "bad" },
    { start: "a3a", end: "a3z", startBlock: 0 },
    { start: "gone", end: "tlen" },
    { start: "", end: "a4" },
    { start: "u4", end: "a5", endBlock: 0 },
];

test("store-backed boundaries equal the per-endpoint reader across every row kind", () => {
    const path = useStore(edgeCaseMessages());
    const db = contextDb();
    addCompartments(db, EDGE_ROWS);
    const outcome = expectSameAsLegacy(db, path) as { resolved?: ResolvedContextBoundary[] };
    // Every row must resolve, so the comparison reaches the code that fills a
    // missing endpoint from its neighbor and finds the message for an empty ID,
    // instead of both versions throwing on the first row.
    expect(outcome.resolved).toHaveLength(EDGE_ROWS.length);
    expect(outcome.resolved?.[1]?.end_message_id).not.toBe("a2#0");
});

test("legacy end IDs inferred from a neighbor resolve their last block from the store", () => {
    const path = useStore(edgeCaseMessages());
    const db = contextDb();
    addCompartments(db, [
        { start: "u1", end: "" },
        { start: "u2", end: "a2" },
    ]);
    const outcome = expectSameAsLegacy(db, path) as { resolved?: ResolvedContextBoundary[] };
    expect(outcome.resolved?.[0]?.end_message_id).toMatch(/^a1#[1-9]/);
});

test("unresolvable rows refuse with the same error as the per-endpoint reader", () => {
    const path = useStore(edgeCaseMessages());
    const db = contextDb();
    addCompartments(db, [
        { start: "u1", end: "a1" },
        { start: "gone-start", end: "gone-end" },
    ]);
    const outcome = expectSameAsLegacy(db, path) as { error?: string };
    expect(outcome.error).toContain("context_compartment_boundary_unresolved");
});

test("every part shape counts the same module blocks as moduleRawBlockMappings", () => {
    const messages: FixtureMessage[] = [
        ...[...PART_CATALOGUE, ...PER_SHAPE_ONLY].map((data, index) => ({
            id: `single-${String(index).padStart(2, "0")}`,
            time: 1_000 + index,
            data: info("assistant"),
            parts: [data],
        })),
        {
            id: "all",
            time: 5_000,
            data: info("assistant"),
            parts: [...PART_CATALOGUE, ...PER_SHAPE_ONLY],
        },
        { id: "none", time: 5_001, data: info("assistant"), parts: [] },
    ];
    const path = useStore(messages);
    const store = new Database(path, { readonly: true });
    try {
        const ids = messages.map((message) => message.id);
        const read = readRawSessionBoundaryEndpointsFromDb(store, SESSION, ids, ids);
        for (const id of ids) {
            const raw = readRawSessionMessagePartsByIdFromDb(store, SESSION, id);
            expect({ id, last: read.get(id)?.lastBlockIndex }).toEqual({
                id,
                last: moduleRawBlockMappings(raw).at(-1)?.blockIndex ?? 0,
            });
        }
        expect(read.get("all")?.lastBlockIndex).toBeGreaterThan(10);
    } finally {
        store.close();
    }
});

test("an unchanged store is not read again, and a host write is always seen", () => {
    const path = useStore(edgeCaseMessages());
    const db = contextDb();
    addCompartments(db, EDGE_ROWS);
    resetRawBoundaryEndpointRowsReadForTest();
    expectSameAsLegacy(db, path);
    const firstRead = getRawBoundaryEndpointRowsReadForTest();
    expect(firstRead).toBeGreaterThan(0);

    // Unchanged store: no boundary message is read again.
    resetRawBoundaryEndpointRowsReadForTest();
    resolveSharedCompartmentBoundaries(db, SESSION);
    expect(getRawBoundaryEndpointRowsReadForTest()).toBe(0);

    // A new compartment reads only its own boundary messages.
    addCompartments(db, [{ start: "u5", end: "u5" }], EDGE_ROWS.length);
    resetRawBoundaryEndpointRowsReadForTest();
    expectSameAsLegacy(db, path);
    expect(getRawBoundaryEndpointRowsReadForTest()).toBe(1);

    const writer = new Database(path);
    try {
        const before = (expectSameAsLegacy(db, path) as { resolved?: ResolvedContextBoundary[] })
            .resolved?.[0]?.end_message_id;
        // A new part on a boundary end moves its last block.
        writer
            .prepare("INSERT INTO part VALUES ('late', 'a1', ?, 1, 1, ?)")
            .run(SESSION, part({ type: "text", text: "appended" }));
        resetRawBoundaryEndpointRowsReadForTest();
        const afterPart = expectSameAsLegacy(db, path) as { resolved?: ResolvedContextBoundary[] };
        expect(getRawBoundaryEndpointRowsReadForTest()).toBeGreaterThan(0);
        expect(afterPart.resolved?.[0]?.end_message_id).not.toBe(before);

        // Deleting an early message shifts every later ordinal.
        writer.prepare("DELETE FROM message WHERE id = 'u1'").run();
        expect((expectSameAsLegacy(db, path) as { resolved?: unknown }).resolved).toBeDefined();

        // A finished summary inserted early removes an ordinal.
        insertMessage(writer, {
            id: "sum0",
            time: 1_000,
            data: info("assistant", { summary: true, finish: "stop" }),
        });
        expect((expectSameAsLegacy(db, path) as { resolved?: unknown }).resolved).toBeDefined();

        // A boundary message turning into a finished summary stops being servable.
        writer
            .prepare("UPDATE message SET data = ? WHERE id = 'u4'")
            .run(info("assistant", { summary: true, finish: "stop" }));
        expect((expectSameAsLegacy(db, path) as { resolved?: unknown }).resolved).toBeDefined();
    } finally {
        writer.close();
    }
});
