import { describe, expect, test } from "bun:test";

import { filesForMode, validateModeManifest } from "./validate-mode-manifest";
import { selectRustShard } from "./select-rust-shard";

describe("rust hermetic shard coverage", () => {
    test("four disjoint shards cover the manifest rust list exactly once", () => {
        const files = filesForMode(validateModeManifest(), "rust");
        const shards = Array.from({ length: 4 }, (_, i) => selectRustShard(files, `${i}/4`));
        const selected = shards.flat();
        expect(selected.length).toBe(files.length);
        expect(new Set(selected).size).toBe(files.length);
        expect([...selected].sort()).toEqual(files);
        expect(shards.every((shard) => shard.length > 0)).toBe(true);
    });

    test("rejects invalid and empty shard specifications", () => {
        const files = filesForMode(validateModeManifest(), "rust");
        for (const spec of ["", "1", "4/4", "-1/4", "0/0", "0/999", "1/1/1"]) {
            expect(() => selectRustShard(files, spec)).toThrow();
        }
    });
});
