import { afterEach, expect, test } from "bun:test";
import {
    appendCompartments,
    getCompartments,
} from "../../features/magic-context/compartment-storage";
import { runMigrations } from "../../features/magic-context/migrations";
import { initializeDatabase } from "../../features/magic-context/storage-db";
import { Database } from "../../shared/sqlite";
import { setRawMessageProvider } from "./read-session-chunk";
import type { RawMessage } from "./read-session-raw";
import {
    resolveSharedCompartmentBoundaries,
    SharedCompartmentBoundaryError,
} from "./shared-compartment-boundaries";

const cleanup: (() => void)[] = [];
afterEach(() => {
    for (const close of cleanup.splice(0)) close();
});
function fixture(start = "m3", end = "m4") {
    const db = new Database(":memory:");
    initializeDatabase(db);
    runMigrations(db);
    cleanup.push(() => db.close());
    const messages: RawMessage[] = Array.from({ length: 5 }, (_, i) => ({
        id: `m${i + 1}`,
        ordinal: i + 1,
        role: "user",
        createdAt: i + 1,
        parts: [{ type: "text", text: `message ${i + 1}` }],
    }));
    cleanup.push(
        setRawMessageProvider("boundaries", {
            readMessages: () => messages,
            readMessagePartsById: (id) => messages.find((m) => m.id === id) ?? null,
            readMessageIdOrdinals: () => new Map(messages.map((m) => [m.id, m.ordinal])),
            getMessageCount: () => messages.length,
        }),
    );
    appendCompartments(db, "boundaries", [
        {
            sequence: 0,
            startMessage: 1,
            endMessage: 2,
            startMessageId: "m1",
            endMessageId: "m2",
            title: "First",
            content: "first summary",
        },
        {
            sequence: 1,
            startMessage: 3,
            endMessage: 4,
            startMessageId: start,
            endMessageId: end,
            title: "Second",
            content: "second summary",
        },
    ]);
    return { db, messages };
}

test("raw boundaries resolve to flat cache coordinates without changing shared rows", () => {
    const { db, messages } = fixture();
    messages[3].parts.push({ type: "text", text: "another block" });
    const before = db.prepare("SELECT * FROM compartments ORDER BY sequence").all();
    const resolved = resolveSharedCompartmentBoundaries(db, "boundaries");
    expect(resolved[1]).toMatchObject({
        source_end_message_id: "m4",
        start_message_id: "m3#0",
        end_message_id: "m4#1",
        start_message: 3,
        end_message: 4,
    });
    expect(db.prepare("SELECT * FROM compartments ORDER BY sequence").all()).toEqual(before);
    expect(Object.keys(resolved[1])).not.toContain("content");
});

test("dangling start heals from the contiguous previous end without changing the stored ID", () => {
    const { db } = fixture("missing-start");
    db.prepare("UPDATE compartments SET start_message=400 WHERE sequence=1").run();
    expect(resolveSharedCompartmentBoundaries(db, "boundaries")[1]).toMatchObject({
        source_start_message_id: "missing-start",
        start_message_id: "missing-start#0",
        start_message: 3,
        end_message: 4,
    });
    expect(db.prepare("SELECT start_message_id FROM compartments WHERE sequence=1").get()).toEqual({
        start_message_id: "missing-start",
    });
});

test("canonical indexed module boundaries reconstruct their flat read coordinates", () => {
    const { db } = fixture("m3", "m4");
    db.prepare(
        "UPDATE compartments SET start_block_index=0, end_block_index=0 WHERE sequence=1",
    ).run();
    expect(getCompartments(db, "boundaries")[1]).toMatchObject({
        startMessageId: "m3",
        endMessageId: "m4",
        startBlockIndex: 0,
        endBlockIndex: 0,
    });
    expect(resolveSharedCompartmentBoundaries(db, "boundaries")[1]).toMatchObject({
        start_message_id: "m3#0",
        end_message_id: "m4#0",
        start_message: 3,
        end_message: 4,
    });
});

test("unprovable coverage refuses by name rather than inventing ordinals", () => {
    const { db } = fixture("missing-start", "missing-end");
    expect(() => resolveSharedCompartmentBoundaries(db, "boundaries")).toThrow(
        SharedCompartmentBoundaryError,
    );
    expect(() => resolveSharedCompartmentBoundaries(db, "boundaries")).toThrow(
        "context_compartment_boundary_unresolved",
    );
});

test("large legacy compartment history reads the ordinal basis once", () => {
    const db = new Database(":memory:");
    initializeDatabase(db);
    runMigrations(db);
    cleanup.push(() => db.close());
    const messages: RawMessage[] = Array.from({ length: 100000 }, (_, index) => ({
        id: `m${index}`,
        ordinal: index + 1,
        role: "user",
        parts: [{ type: "text", text: "x" }],
    }));
    const byId = new Map(messages.map((message) => [message.id, message]));
    let ordinalReads = 0;
    let endpointReads = 0;
    cleanup.push(
        setRawMessageProvider("large-boundaries", {
            readMessages: () => messages,
            readMessageIdOrdinals: () => {
                ordinalReads += 1;
                return new Map(messages.map((message) => [message.id, message.ordinal]));
            },
            readMessagePartsById: (id) => {
                endpointReads += 1;
                return byId.get(id) ?? null;
            },
            getMessageCount: () => messages.length,
        }),
    );
    appendCompartments(
        db,
        "large-boundaries",
        Array.from({ length: 2000 }, (_, sequence) => ({
            sequence,
            startMessage: 1,
            endMessage: 100000,
            startMessageId: "m0",
            endMessageId: "m99999",
            title: "summary",
            content: "x",
        })),
    );
    expect(resolveSharedCompartmentBoundaries(db, "large-boundaries")).toHaveLength(2000);
    expect(ordinalReads).toBe(1);
    expect(endpointReads).toBe(2);
});

test("empty legacy start ID heals to a real message while preserving source identity and partial end", () => {
    const { db } = fixture("");
    db.prepare("UPDATE compartments SET end_block_index=0 WHERE sequence=1").run();
    const before = db.prepare("SELECT * FROM compartments ORDER BY sequence").all();
    expect(resolveSharedCompartmentBoundaries(db, "boundaries")[1]).toMatchObject({
        source_start_message_id: "",
        source_start_block_index: null,
        start_message: 3,
        start_message_id: "m3#0",
        source_end_message_id: "m4",
        source_end_block_index: 0,
        end_message_id: "m4#0",
    });
    expect(db.prepare("SELECT * FROM compartments ORDER BY sequence").all()).toEqual(before);
});

test("empty legacy end ID heals from the next start, retaining the inferred message's last block", () => {
    const { db, messages } = fixture();
    messages[1].parts.push({ type: "text", text: "second block" });
    db.prepare("UPDATE compartments SET end_message_id='' WHERE sequence=0").run();
    expect(resolveSharedCompartmentBoundaries(db, "boundaries")[0]).toMatchObject({
        source_end_message_id: "",
        source_end_block_index: null,
        end_message: 2,
        end_message_id: "m2#1",
    });
});

test("empty indexed source ID cannot be substituted with an inferred message", () => {
    const { db } = fixture("");
    db.prepare("UPDATE compartments SET start_block_index=0 WHERE sequence=1").run();
    expect(() => resolveSharedCompartmentBoundaries(db, "boundaries")).toThrow(
        SharedCompartmentBoundaryError,
    );
});
