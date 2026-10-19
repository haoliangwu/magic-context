import { afterEach, expect, test } from "bun:test";
import { initializeDatabase } from "../../features/magic-context/storage-db";
import { Database } from "../../shared/sqlite";
import { prepareLegacyToolSkeletonConversions } from "./apply-operations";
import type { TagTarget } from "./tag-messages";

const connections: Database[] = [];
afterEach(() => {
    for (const db of connections.splice(0)) db.close();
});

function fixture() {
    const db = new Database(":memory:");
    connections.push(db);
    initializeDatabase(db);
    const insert = db.prepare(
        "INSERT INTO tags(session_id, tag_number, message_id, type, status, drop_mode) VALUES ('s', ?, ?, 'tool', 'dropped', ?)",
    );
    for (let tag = 1; tag <= 1000; tag++) insert.run(tag, `call-${tag}`, "truncated");
    return db;
}

const target = (overrides: Partial<TagTarget> = {}): TagTarget =>
    ({
        canDrop: () => true,
        cannotRemove: () => false,
        inputStringBytes: () => 50,
        ...overrides,
    }) as TagTarget;

test("legacy conversion reads only wire candidates, including writer validation", () => {
    const db = fixture();
    let rowsRead = 0;
    const prepare = db.prepare.bind(db);
    db.prepare = ((sql: string) => {
        const statement = prepare(sql);
        if (!sql.includes("SELECT tag_number AS tagNumber")) return statement;
        return new Proxy(statement, {
            get(object, key) {
                const value = Reflect.get(object, key);
                if (key === "all" || key === "get")
                    return (...args: unknown[]) => {
                        const result = value.apply(object, args);
                        rowsRead += Array.isArray(result) ? result.length : result ? 1 : 0;
                        return result;
                    };
                return typeof value === "function" ? value.bind(object) : value;
            },
        });
    }) as typeof db.prepare;
    const prepared = prepareLegacyToolSkeletonConversions(db, "s", new Map([[900, target()]]));
    expect(prepared.isCurrent(db)).toBe(true);
    expect([...prepared.converted]).toEqual([[900, "skeleton_real"]]);
    expect(rowsRead).toBe(2);
    prepared.persist(db);
    expect(db.prepare("SELECT drop_mode FROM tags WHERE tag_number=899").get()).toEqual({
        drop_mode: "truncated",
    });
});

test("legacy conversion validates candidate mode, identity, eligibility, and absence", () => {
    for (const sql of [
        "UPDATE tags SET drop_mode='full' WHERE tag_number=900",
        "UPDATE tags SET message_id='replacement-call' WHERE tag_number=900",
        "UPDATE tags SET status='active' WHERE tag_number=900",
        "UPDATE tags SET type='message' WHERE tag_number=900",
        "DELETE FROM tags WHERE tag_number=900",
    ]) {
        const db = fixture();
        const prepared = prepareLegacyToolSkeletonConversions(db, "s", new Map([[900, target()]]));
        db.exec(sql);
        expect(prepared.isCurrent(db)).toBe(false);
    }
});

test("legacy conversion detects a newly eligible wire tag but ignores off-wire changes", () => {
    const db = fixture();
    db.exec("UPDATE tags SET status='active' WHERE tag_number=900");
    const prepared = prepareLegacyToolSkeletonConversions(db, "s", new Map([[900, target()]]));
    db.exec("UPDATE tags SET drop_mode='full' WHERE tag_number=1");
    expect(prepared.isCurrent(db)).toBe(true);
    db.exec("UPDATE tags SET status='dropped' WHERE tag_number=900");
    expect(prepared.isCurrent(db)).toBe(false);
});

test("legacy conversion preserves sorted decisions and Pi full-drop exemptions", () => {
    const db = fixture();
    db.exec("UPDATE tags SET drop_mode='full' WHERE tag_number IN (3,4,5)");
    const prepared = prepareLegacyToolSkeletonConversions(
        db,
        "s",
        new Map([
            [6, target({ canDrop: () => false })],
            [5, target({ cannotRemove: () => true })],
            [4, target()],
            [3, target({ cannotRemove: () => true })],
            [2, target({ inputStringBytes: () => 5000 })],
            [1, target()],
        ]),
        { keepFullDrop: (id) => id === "call-3" },
    );
    expect([...prepared.converted]).toEqual([
        [1, "skeleton_real"],
        [2, "full"],
        [5, "skeleton_real"],
    ]);
});

test("legacy conversion with an empty wire has no rows or decisions", () => {
    const db = fixture();
    const prepared = prepareLegacyToolSkeletonConversions(db, "s", new Map());
    expect(prepared.converted.size).toBe(0);
    expect(prepared.isCurrent(db)).toBe(true);
});
