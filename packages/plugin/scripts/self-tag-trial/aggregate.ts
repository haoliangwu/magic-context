import { readFileSync, writeFileSync } from "node:fs";
const base = process.argv[2] ?? "docs/reports/issue-582-self-tag";
const phases = ["live", "supplement", "pilot", "supplement-failed"];
const result: any = { responseModels: [], variants: {}, buckets: [], spend: {}, phases: [] };
const benchmarkRows: any[] = [];
const total = { calls: 0, input: 0, output: 0, cacheHit: 0, cacheMiss: 0 };
for (const phase of phases) {
    const summary = JSON.parse(readFileSync(`${base}-${phase}-summary.json`, "utf8"));
    const tokens = { calls: summary.calls.length, input: 0, output: 0, cacheHit: 0, cacheMiss: 0 };
    for (const call of summary.calls) {
        tokens.input += call.usage?.prompt_tokens ?? 0; tokens.output += call.usage?.completion_tokens ?? 0;
        tokens.cacheHit += call.usage?.prompt_cache_hit_tokens ?? 0; tokens.cacheMiss += call.usage?.prompt_cache_miss_tokens ?? 0;
    }
    for (const key of Object.keys(total) as (keyof typeof total)[]) total[key] += tokens[key];
    result.phases.push({ phase, ...tokens });
    if (phase === "live" || phase === "supplement") benchmarkRows.push(...readFileSync(`${base}-${phase}.jsonl`, "utf8").trim().split("\n").filter(Boolean).map(line => ({ ...JSON.parse(line), cohort: phase })));
}
const count = (rows: any[]) => ({ textParts: rows.length, wellFormed: rows.filter(row => row.wellFormed).length,
    canonicalPrefix: rows.filter(row => row.canonicalPrefix).length, correct: rows.filter(row => row.correct === true).length,
    wrongNumber: rows.filter(row => row.delta !== null && row.delta !== 0).length, malformed: rows.filter(row => row.malformed).length,
    misplaced: rows.filter(row => row.misplaced).length, byteIdentity: rows.filter(row => row.byteIdentity).length });
for (const variant of ["A", "B"]) {
    const rows = benchmarkRows.filter(row => row.variant === variant);
    result.variants[variant] = { sessions: new Set(rows.map(row => row.session)).size, replies: rows.length,
        toolOnly: rows.filter(row => row.toolOnly).length, ...count(rows.filter(row => !row.toolOnly)) };
    for (const bucket of [{ name: "1", min: 1, max: 1 }, { name: "2–5", min: 2, max: 5 }, { name: "6–20", min: 6, max: 20 }, { name: ">20", min: 21, max: Infinity }]) result.buckets.push({ variant, bucket: bucket.name, ...count(rows.filter(row => !row.toolOnly && row.position >= bucket.min && row.position <= bucket.max)) });
}
result.responseModels = [...new Set(benchmarkRows.map(row => row.responseModel))];
result.spend = { ...total, rejectedSetupRequests: 2, allRequests: total.calls + 2,
    estimatedOffPeakUSD: (total.cacheHit * 0.003 + total.cacheMiss * 0.15 + total.output * 0.6) / 1e6,
    estimatedPeakUSD: (total.cacheHit * 0.006 + total.cacheMiss * 0.3 + total.output * 1.2) / 1e6,
    pricingSource: "https://api-docs.deepseek.com/quick_start/pricing", pricingAccessed: "2026-09-30" };
writeFileSync(`${base}-all.jsonl`, benchmarkRows.map(row => JSON.stringify(row)).join("\n") + "\n");
writeFileSync(`${base}-aggregate.json`, JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
