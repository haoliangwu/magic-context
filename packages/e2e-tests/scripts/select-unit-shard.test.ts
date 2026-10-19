import { expect, test } from "bun:test";
import { selectUnitShard, unitFiles } from "./select-unit-shard";

for (const packageName of ["plugin", "pi-plugin"] as const) {
    for (const mode of ["normal", "assertions"] as const) {
        test(`${packageName} ${mode}: four nonempty disjoint shards equal full package discovery`, () => {
            const expected = unitFiles(packageName);
            const shards = Array.from({ length: 4 }, (_, shard) => selectUnitShard(packageName, mode, `${shard}/4`));
            const selected = shards.flat();
            expect(shards.every((shard) => shard.length > 0)).toBe(true);
            expect(selected.length).toBe(expected.length);
            expect(new Set(selected).size).toBe(expected.length);
            expect(selected.sort()).toEqual(expected);
            expect(selected.every((file) => !file.includes("node_modules/"))).toBe(true);
        });
    }
}

test("unit selectors reject invalid shard specifications", () => {
    for (const spec of ["", "4/4", "0/0", "0/9999", "-1/4"]) {
        expect(() => selectUnitShard("plugin", "normal", spec)).toThrow();
    }
});
