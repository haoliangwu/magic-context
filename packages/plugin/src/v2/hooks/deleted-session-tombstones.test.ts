import { expect, test } from "bun:test";
import { DeletedSessionTombstones } from "./deleted-session-tombstones";

test("bounds deleted-session tombstones while retaining recent deletions", () => {
    const tombstones = new DeletedSessionTombstones(3);
    for (const id of ["oldest", "middle", "newer", "newest"]) tombstones.add(id);

    expect(tombstones.size).toBe(3);
    expect(tombstones.has("oldest")).toBe(false);
    expect(tombstones.has("middle")).toBe(true);
    expect(tombstones.has("newest")).toBe(true);
});

test("refreshes a duplicate tombstone and clears on disposal", () => {
    const tombstones = new DeletedSessionTombstones(2);
    tombstones.add("a");
    tombstones.add("b");
    tombstones.add("a");
    tombstones.add("c");

    expect(tombstones.has("a")).toBe(true);
    expect(tombstones.has("b")).toBe(false);
    tombstones.clear();
    expect(tombstones.size).toBe(0);
});
