import { afterEach, expect, spyOn, test } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runMigrations } from "../../features/magic-context/migrations";
import { initializeDatabase } from "../../features/magic-context/storage-db";
import {
    invalidateReplayEnvelopeSnapshot,
    readReplayEnvelope,
    updateReplayDocument,
    withReplayEnvelopeSnapshot,
} from "../../features/magic-context/storage-replay-document";
import { Database } from "../../shared/sqlite";
import { createTestTempDirFromPath } from "../../shared/test-temp-dir";
import { EmergencyFailClosedError } from "./emergency-fail-closed";
import {
    noteRustServedRaw,
    preserveRustServedRaw,
    releaseRustServedRaw,
    servedRawBlockIds,
} from "./rust-served-raw";
import type { MessageLike } from "./transform-operations";

const directories: string[] = [];
const databases: Database[] = [];
afterEach(() => {
    for (const db of databases.splice(0)) db.close();
    for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});

function fixture() {
    const dir = createTestTempDirFromPath(join(tmpdir(), "rust-served-raw-"));
    directories.push(dir);
    const path = join(dir, "context.db");
    const db = new Database(path);
    initializeDatabase(db);
    runMigrations(db);
    databases.push(db);
    const input = [
        {
            info: { id: "assistant", role: "assistant", sessionID: "raw" },
            parts: [
                {
                    id: "thinking",
                    type: "reasoning",
                    text: "signed thinking",
                    metadata: { anthropic: { signature: "sig" } },
                },
                {
                    id: "result",
                    type: "tool",
                    tool: "read",
                    callID: "call",
                    state: { status: "completed", input: {}, output: "raw result" },
                },
                { id: "text", type: "text", text: "raw text" },
            ],
        },
    ] as MessageLike[];
    return { db, path, input };
}

test("served raw evidence survives a new database connection and matches native IDs, not part positions", () => {
    const { db, path, input } = fixture();
    const served = structuredClone(input);
    (served[0]!.parts[2] as { text: string }).text = "§77§ raw text";
    noteRustServedRaw(db, "raw", input, served);
    expect(servedRawBlockIds(db, "raw")).toEqual(["assistant#0", "assistant#1", "assistant#2"]);
    const reopened = new Database(path);
    databases.push(reopened);
    const candidate = structuredClone(served);
    candidate[0]!.parts.shift();
    (candidate[0]!.parts[0] as { state: { output: string } }).state.output = "§9§ raw result";
    preserveRustServedRaw(reopened, "raw", candidate, input);
    expect(JSON.stringify(candidate)).toBe(JSON.stringify(served));
    releaseRustServedRaw(reopened, "raw", candidate);
    expect(servedRawBlockIds(reopened, "raw")).toEqual([
        "assistant#0",
        "assistant#1",
        "assistant#2",
    ]);
    (candidate[0]!.parts[1] as { state: { output: string } }).state.output = "§9§ raw result";
    releaseRustServedRaw(reopened, "raw", candidate);
    expect(servedRawBlockIds(reopened, "raw")).toEqual(["assistant#0"]);
});

test("every raw serve refreshes a completed part and its newly projected result block", () => {
    const { db, input } = fixture();
    input[0]!.parts.pop();
    const pending = structuredClone(input);
    (pending[0]!.parts[1] as { state: { status: string } }).state.status = "running";
    noteRustServedRaw(db, "raw", pending, pending);
    expect(servedRawBlockIds(db, "raw")).toEqual(["assistant#0"]);
    noteRustServedRaw(db, "raw", input, input);
    expect(servedRawBlockIds(db, "raw")).toContain("assistant#2");
    (input[0]!.parts[1] as { state: { output: string } }).state.output = "updated result";
    noteRustServedRaw(db, "raw", input, input);
    const candidate = structuredClone(input);
    (candidate[0]!.parts[1] as { state: { output: string } }).state.output = "§5§ updated result";
    preserveRustServedRaw(db, "raw", candidate, input);
    expect(candidate).toEqual(input);
});

test("ambiguous ID-less raw parts fail closed rather than overwriting a same-type neighbor", () => {
    const { db, input } = fixture();
    delete (input[0]!.parts[2] as { id?: string }).id;
    noteRustServedRaw(db, "raw", input, input);
    const candidate = structuredClone(input);
    (candidate[0]!.parts[2] as { text: string }).text = "different neighbor";
    expect(() => preserveRustServedRaw(db, "raw", candidate, input)).toThrow(
        EmergencyFailClosedError,
    );
});

test("a session with no raw replay evidence has no output normalization or persistence", () => {
    const { db } = fixture();
    const candidate = ["legacy fixture"] as unknown as MessageLike[];
    preserveRustServedRaw(db, "untouched", candidate);
    releaseRustServedRaw(db, "untouched", candidate);
    expect(candidate).toEqual(["legacy fixture"]);
    expect(
        db.query("SELECT session_id FROM session_meta WHERE session_id = ?").get("untouched"),
    ).toBeNull();
});

test("raw receipts contain structural digests, not duplicate native payloads, and key order does not consume them", () => {
    const { db, input } = fixture();
    (input[0]!.parts[1] as { state: { output: string } }).state.output =
        "large native output ".repeat(1000);
    const shared = { label: "same value" };
    (input[0]!.parts[1] as Record<string, unknown>).metadata = { first: shared, second: shared };
    const reordered = JSON.parse(JSON.stringify(input)) as MessageLike[];
    reordered[0]!.parts = reordered[0]!.parts.map((part) =>
        Object.fromEntries(Object.entries(part as object).reverse()),
    );
    noteRustServedRaw(db, "raw", input, reordered);
    expect(servedRawBlockIds(db, "raw")).toHaveLength(4);
    const stored = db
        .prepare("SELECT trailing_blank_decisions AS doc FROM session_meta WHERE session_id=?")
        .get("raw") as { doc: string };
    expect(Buffer.byteLength(stored.doc)).toBeLessThan(1024);
    expect(stored.doc).not.toContain("large native output");
    preserveRustServedRaw(db, "raw", reordered, input);
    releaseRustServedRaw(db, "raw", reordered);
    expect(servedRawBlockIds(db, "raw")).toHaveLength(4);
    const before = db.prepare("SELECT total_changes() AS n").get() as { n: number };
    noteRustServedRaw(db, "raw", input, reordered);
    expect((db.prepare("SELECT total_changes() AS n").get() as { n: number }).n).toBe(before.n);
});

test("a replay-envelope read view is invalidated by writes and explicit module handoffs", async () => {
    const { db } = fixture();
    const original = db.prepare.bind(db);
    let reads = 0;
    const spy = spyOn(db, "prepare").mockImplementation(((sql: string) => {
        if (sql === "SELECT trailing_blank_decisions FROM session_meta WHERE session_id = ?")
            reads++;
        return original(sql);
    }) as typeof db.prepare);
    try {
        await withReplayEnvelopeSnapshot(db, "raw", async () => {
            readReplayEnvelope(db, "raw");
            servedRawBlockIds(db, "raw");
            readReplayEnvelope(db, "raw");
            expect(reads).toBe(1);
            expect(
                updateReplayDocument(db, "raw", (doc) => {
                    doc.version = 2;
                    doc.marker = "own";
                    return true;
                }),
            ).toBe(true);
            expect(readReplayEnvelope(db, "raw").marker).toBe("own");
            const prior = reads;
            invalidateReplayEnvelopeSnapshot(db, "raw");
            expect(readReplayEnvelope(db, "raw").marker).toBe("own");
            expect(reads).toBe(prior + 1);
            db.prepare("UPDATE session_meta SET trailing_blank_decisions=? WHERE session_id=?").run(
                JSON.stringify({ version: 2, trailingBlank: {}, peer: "retained" }),
                "raw",
            );
            expect(
                updateReplayDocument(db, "raw", (doc) => {
                    doc.marker = "merged";
                    return true;
                }),
            ).toBe(true);
            expect(readReplayEnvelope(db, "raw")).toMatchObject({
                peer: "retained",
                marker: "merged",
            });
        });
        const prior = reads;
        readReplayEnvelope(db, "raw");
        readReplayEnvelope(db, "raw");
        expect(reads).toBe(prior + 2);
    } finally {
        spy.mockRestore();
    }
});

test("background work inherited from a finished pass cannot reuse its stale replay snapshot", async () => {
    const { db } = fixture();
    expect(
        updateReplayDocument(db, "raw", (doc) => {
            doc.version = 2;
            doc.marker = "before";
            return true;
        }),
    ).toBe(true);
    let resume: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
        resume = resolve;
    });
    let later: Promise<unknown> = Promise.resolve(undefined);
    await withReplayEnvelopeSnapshot(db, "raw", async () => {
        expect(readReplayEnvelope(db, "raw").marker).toBe("before");
        later = gate.then(() => readReplayEnvelope(db, "raw").marker);
    });
    expect(
        updateReplayDocument(db, "raw", (doc) => {
            doc.marker = "after";
            return true;
        }),
    ).toBe(true);
    resume();
    expect(await later).toBe("after");
});
