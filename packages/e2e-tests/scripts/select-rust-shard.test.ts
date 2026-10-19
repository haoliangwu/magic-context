import { describe, expect, test } from "bun:test";

import { filesForMode, validateModeManifest } from "./validate-mode-manifest";
import { selectRustShard } from "./select-rust-shard";
import { selectWeightedShard } from "./select-weighted-shard";

describe("rust hermetic shard coverage", () => {
    test("four disjoint shards cover the manifest rust list exactly once", () => {
        const validation = validateModeManifest();
        const files = filesForMode(validation, "rust");
        const shards = Array.from({ length: 4 }, (_, i) => selectRustShard(files, `${i}/4`));
        const selected = shards.flat();
        expect(selected.length).toBe(files.length);
        expect(new Set(selected).size).toBe(files.length);
        expect([...selected].sort()).toEqual(files);
        expect(shards.every((shard) => shard.length > 0)).toBe(true);
        for (const entry of validation.manifest.entries) {
            if (!entry.invocation.rust) expect(selected).not.toContain(entry.path);
        }
    });

    test("rejects invalid and empty shard specifications", () => {
        const files = filesForMode(validateModeManifest(), "rust");
        for (const spec of ["", "1", "4/4", "-1/4", "0/0", "0/999", "1/1/1"]) {
            expect(() => selectRustShard(files, spec)).toThrow();
        }
    });

    test("balances by elapsed seconds rather than file count and is input-order independent", () => {
        const files = ["a", "b", "c", "d", "e"];
        const seconds = { a: 100, b: 30, c: 30, d: 20, e: 20 };
        expect(selectWeightedShard(files, "0/2", seconds)).toEqual(["a"]);
        expect(selectWeightedShard(files, "1/2", seconds)).toEqual(["b", "c", "d", "e"]);
        expect(selectWeightedShard([...files].reverse(), "1/2", seconds)).toEqual(["b", "c", "d", "e"]);
    });

    test("new files get the measured median and stale timing entries never become members", () => {
        expect(selectWeightedShard(["known", "new"], "1/2", { known: 10, stale: 100 })).toEqual(["known"]);
        expect(selectWeightedShard(["known", "new"], "0/2", { known: 10, stale: 100 })).toEqual(["new"]);
    });

    test("rejects duplicate inputs and invalid timing data", () => {
        expect(() => selectWeightedShard(["a", "a"], "0/1", { a: 1 })).toThrow();
        const invalid: Record<string, number>[] = [{}, { a: 0 }, { a: -1 }, { a: Number.NaN }];
        for (const seconds of invalid) {
            expect(() => selectWeightedShard(["a"], "0/1", seconds)).toThrow();
        }
    });
});
