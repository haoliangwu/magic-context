#!/usr/bin/env bun

import { resolve } from "node:path";

export function failedRequiredJobs(required: string[], needs: Record<string, { result?: string }>): string[] {
    if (required.length === 0 || new Set(required).size !== required.length) throw new Error("invalid required job list");
    return required.filter((job) => needs[job]?.result !== "success");
}

if (import.meta.main) {
    try {
        const workflow = Bun.YAML.parse(await Bun.file(resolve(import.meta.dir, "../../..", ".github/workflows/ci.yml")).text()) as {
            jobs: Record<string, { needs?: string[] }>;
        };
        const job = process.argv[2];
        const required = job ? workflow.jobs[job]?.needs : undefined;
        if (!required || process.argv.length !== 3) throw new Error("usage: check-ci-results.ts aggregate-job-id");
        const needs = JSON.parse(process.env.CI_NEEDS ?? "null") as Record<string, { result?: string }> | null;
        if (!needs || typeof needs !== "object" || Array.isArray(needs)) throw new Error("CI_NEEDS must be a needs result object");
        for (const name of required) console.log(`${name}: ${needs[name]?.result ?? "MISSING"}`);
        const failed = failedRequiredJobs(required, needs);
        if (failed.length > 0) throw new Error(`required CI jobs did not succeed: ${failed.join(", ")}`);
        console.log(`${job}: all ${required.length} required jobs succeeded`);
    } catch (error) {
        console.error(String(error));
        process.exit(1);
    }
}
