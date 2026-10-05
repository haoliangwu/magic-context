#!/usr/bin/env bun

import { filesForMode, validateModeManifest } from "./validate-mode-manifest";

/** Stable manifest-order partition; every file belongs to exactly one shard. */
export function selectRustShard(files: string[], spec: string): string[] {
    const match = /^(\d+)\/(\d+)$/.exec(spec);
    if (!match) throw new Error(`invalid MC_E2E_SHARD: ${spec} (expected i/n)`);
    const index = Number(match[1]);
    const count = Number(match[2]);
    if (!Number.isSafeInteger(index) || !Number.isSafeInteger(count) || count < 1 || count > files.length || index >= count) {
        throw new Error(`invalid MC_E2E_SHARD: ${spec} (expected 0 <= i < n)`);
    }
    return files.filter((_, position) => position % count === index);
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
