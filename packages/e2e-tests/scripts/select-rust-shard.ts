#!/usr/bin/env bun

import { filesForMode, validateModeManifest } from "./validate-mode-manifest";
import durations from "./shard-durations.json";
import { selectWeightedShard } from "./select-weighted-shard";

/** The validated manifest owns membership; historical timings only affect assignment. */
export function selectRustShard(files: string[], spec: string): string[] {
    return selectWeightedShard(files, spec, durations.seconds.rust);
}

if (import.meta.main) {
    try {
        const spec = process.argv[2];
        if (!spec || process.argv.length !== 3) throw new Error("usage: select-rust-shard.ts i/n");
        for (const path of selectRustShard(filesForMode(validateModeManifest(), "rust"), spec)) {
            console.log(path);
        }
    } catch (error) {
        console.error(String(error));
        process.exit(1);
    }
}
