import { readFileSync, writeFileSync } from "node:fs";
import { hasMisplacedTextTag } from "./measure";
const prefix = process.argv[2] ?? "docs/reports/issue-582-self-tag-live";
const rows = readFileSync(`${prefix}.jsonl`, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
const summary = JSON.parse(readFileSync(`${prefix}-summary.json`, "utf8"));
for (const row of rows) {
    const provider = summary.calls.find((call: any) => call.index === row.providerCallIndex);
    row.providerArgumentTags = provider?.calls.some((call: any) => /§/.test(String(call.arguments ?? ""))) ?? false;
    row.misplaced ||= row.providerArgumentTags || hasMisplacedTextTag(row.raw);
    const pair = /^§(\d+)§/.exec(row.raw);
    row.wellFormed = !!pair;
    row.canonicalPrefix = /^§\d+§ /.test(row.raw);
    row.malformed = /§/.test(row.raw.replace(/§\d+§/g, ""));
    row.correct = row.assignedTag !== null ? !!pair && Number(pair[1]) === row.assignedTag : null;
    row.delta = pair && row.assignedTag !== null ? Number(pair[1]) - row.assignedTag : null;
}
writeFileSync(`${prefix}.jsonl`, rows.map(row => JSON.stringify(row)).join("\n") + "\n");
const buckets = [{ name: "1", min: 1, max: 1 }, { name: "2–5", min: 2, max: 5 }, { name: "6–20", min: 6, max: 20 }, { name: ">20", min: 21, max: Infinity }];
const aggregate = (data: any[]) => ({ rows: data.length, wellFormed: data.filter(r => r.wellFormed).length,
    canonicalPrefix: data.filter(r => r.canonicalPrefix).length, correct: data.filter(r => r.correct === true).length, wrong: data.filter(r => r.delta !== null && r.delta !== 0).length,
    untagged: data.filter(r => !r.wellFormed).length, malformed: data.filter(r => r.malformed).length,
    misplaced: data.filter(r => r.misplaced).length, byteIdentity: data.filter(r => r.byteIdentity === true).length });
const result: any = { responseModels: [...new Set(rows.map(r => r.responseModel))], variants: {}, sessions: [], buckets: [], errors: summary.calls.filter((c: any) => c.status !== undefined && c.status !== 200),
    credentials: { copiedDeleted: summary.copiedCredentialDeleted, stagedDeleted: summary.stagedCredentialDeleted } };
for (const variant of [...new Set(rows.map(r => r.variant))]) {
    const data = rows.filter(r => r.variant === variant);
    const calls = summary.sessions.filter((s: any) => s.variant === variant).flatMap((s: any) => summary.calls.slice(s.providerCallStart, s.providerCallEnd));
    const usage = calls.reduce((total: any, c: any) => {
        total.input += c.usage?.prompt_tokens ?? 0; total.output += c.usage?.completion_tokens ?? 0;
        total.cacheHit += c.usage?.prompt_cache_hit_tokens ?? 0; total.cacheMiss += c.usage?.prompt_cache_miss_tokens ?? 0;
        return total;
    }, { input: 0, output: 0, cacheHit: 0, cacheMiss: 0 });
    result.variants[variant] = { sessions: summary.sessions.filter((s: any) => s.variant === variant && s.completed).length,
        sessionsStarted: summary.sessions.filter((s: any) => s.variant === variant).length,
        calls: calls.length, usage, text: aggregate(data.filter(r => !r.toolOnly)), toolOnly: data.filter(r => r.toolOnly).length,
        toolOnlyMisplaced: data.filter(r => r.toolOnly && r.misplaced).length,
        signedDeltas: Object.fromEntries([...new Set(data.filter(r => r.delta !== null && r.delta !== 0).map(r => r.delta))].map(delta => [delta, data.filter(r => r.delta === delta).length])) };
    for (const bucket of buckets) result.buckets.push({ variant, bucket: bucket.name, ...aggregate(data.filter(r => !r.toolOnly && r.position >= bucket.min && r.position <= bucket.max)) });
}
for (const session of summary.sessions) result.sessions.push({ ...Object.fromEntries(["session", "variant", "scenario", "replicate", "completed", "lastCompletedTurn", "replies", "parallelSeen", "placeholderSeen", "providerHookTextEqual", "reductionTarget", "providerSawReductionTarget", "reductionStatus"].map(key => [key, session[key]])),
    ...aggregate(rows.filter(r => r.session === session.session && !r.toolOnly)) });
const columns = ["model", "requestedModel", "responseModel", "variant", "scenario", "session", "position", "userTurn", "providerCallIndex", "rawFirst60", "assignedTag", "wellFormed", "canonicalPrefix", "correct", "delta", "malformed", "misplaced", "byteIdentity", "toolOnly", "tagOnlyText", "reasoningTokens", "finish"];
const csv = (value: unknown) => `"${String(value ?? "").replaceAll('"', '""')}"`;
writeFileSync(`${prefix}.csv`, columns.join(",") + "\n" + rows.map(row => columns.map(key => csv(row[key])).join(",")).join("\n") + "\n");
writeFileSync(`${prefix}-analysis.json`, JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
