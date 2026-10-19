#!/usr/bin/env bun

import durations from "./shard-durations.json";
import { selectWeightedShard } from "./select-weighted-shard";
import { filesForMode, validateModeManifest, type ValidationResult } from "./validate-mode-manifest";

export type ShardedHost = "opencode" | "opencode2";

export function selectHostShard(host: ShardedHost, spec: string, validation: ValidationResult = validateModeManifest()): string[] {
    return selectWeightedShard(filesForMode(validation, "ts", host), spec, durations.seconds[host]);
}

if (import.meta.main) {
    try {
        const [host, spec] = process.argv.slice(2);
        if ((host !== "opencode" && host !== "opencode2") || !spec || process.argv.length !== 4) {
            throw new Error("usage: select-host-shard.ts opencode|opencode2 i/n");
        }
        for (const file of selectHostShard(host, spec)) console.log(file);
    } catch (error) {
        console.error(String(error));
        process.exit(1);
    }
}
