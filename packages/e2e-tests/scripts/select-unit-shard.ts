#!/usr/bin/env bun

import { resolve } from "node:path";
import durations from "./unit-shard-durations.json";
import { selectWeightedShard } from "./select-weighted-shard";

export type UnitPackage = "plugin" | "pi-plugin";
export type UnitMode = "normal" | "assertions";

export function unitFiles(packageName: UnitPackage): string[] {
    const cwd = resolve(import.meta.dir, "../..", packageName);
    return [...new Bun.Glob("**/*").scanSync({ cwd, onlyFiles: true })]
        .filter((file) => !file.split("/").some((part) => part === "node_modules" || part === ".git"))
        .filter((file) => /[._](test|spec)\.[jt]sx?$/.test(file))
        .sort();
}

export function selectUnitShard(packageName: UnitPackage, mode: UnitMode, spec: string): string[] {
    const measured = durations.packages[packageName];
    const column = mode === "normal" ? 0 : 1;
    const seconds = Object.fromEntries(Object.entries(measured.seconds).map(([file, pair]) => [file, pair[column]!]));
    return selectWeightedShard(unitFiles(packageName), spec, seconds, measured.fallbackSeconds[mode]);
}

if (import.meta.main) {
    try {
        const [packageName, mode, spec] = process.argv.slice(2);
        if ((packageName !== "plugin" && packageName !== "pi-plugin") || (mode !== "normal" && mode !== "assertions") || !spec || process.argv.length !== 5) {
            throw new Error("usage: select-unit-shard.ts plugin|pi-plugin normal|assertions i/n");
        }
        for (const file of selectUnitShard(packageName, mode, spec)) console.log(`./${file}`);
    } catch (error) {
        console.error(String(error));
        process.exit(1);
    }
}
