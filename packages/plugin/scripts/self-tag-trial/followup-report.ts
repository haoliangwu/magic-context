import { readFileSync, writeFileSync, mkdirSync } from "node:fs";

const base = process.argv[2] ?? "docs/reports/issue-582-self-tag";
const suffix = process.argv[3] ?? "c";
const phases = process.argv.slice(4);
if (!phases.length) throw new Error("Supply phase names, e.g. live-c supplement-c");
const rows: any[] = [];
const sessions: any[] = [];
const calls: any[] = [];
for (const phase of phases) {
    const summary = JSON.parse(readFileSync(`${base}-${phase}-summary.json`, "utf8"));
    rows.push(...readFileSync(`${base}-${phase}.jsonl`, "utf8").trim().split("\n").filter(Boolean).map(line => ({ ...JSON.parse(line), cohort: phase })));
    sessions.push(...summary.sessions.map((s: any) => ({ ...s, cohort: phase })));
    calls.push(...summary.calls.map((c: any) => ({ ...c, cohort: phase })));
}
const count = (data: any[]) => ({ textParts: data.length, closed: data.filter(r => r.wellFormed).length,
    canonical: data.filter(r => r.canonicalPrefix).length, correct: data.filter(r => r.correct === true).length,
    wrong: data.filter(r => r.delta !== null && r.delta !== 0).length, malformed: data.filter(r => r.malformed).length,
    misplaced: data.filter(r => r.misplaced).length, identical: data.filter(r => r.byteIdentity === true).length,
    proseReferences: data.filter(r => /\btag\s+\d+\b/i.test(r.raw)).length,
    midTextNotation: data.filter(r => /§/.test(r.raw.replace(/^\s*§\S*\s?/, ""))).length });
const variants = [...new Set(rows.map(r => r.variant))];
const pooled = variants.map(variant => ({ variant, replies: rows.filter(r => r.variant === variant).length, ...count(rows.filter(r => r.variant === variant && !r.toolOnly)) }));
const buckets = variants.flatMap(variant => [["1", 1, 1], ["2–5", 2, 5], ["6–20", 6, 20], [">20", 21, Infinity]].map(([bucket, min, max]) => ({ variant, bucket, ...count(rows.filter(r => r.variant === variant && !r.toolOnly && r.position >= Number(min) && r.position <= Number(max))) })));
const firstMixed = sessions.map(s => {
    const row = rows.find(r => r.session === s.session && !r.toolOnly && r.providerToolCalls?.length);
    return { variant: s.variant, scenario: s.scenario, replicate: s.replicate, session: s.session, position: row?.position ?? null, assigned: row?.assignedTag, raw: row?.raw ?? null, identical: row?.byteIdentity ?? null };
});
const usage = calls.reduce((t, c) => {
    t.input += c.usage?.prompt_tokens ?? 0; t.output += c.usage?.completion_tokens ?? 0;
    t.cacheHit += c.usage?.prompt_cache_hit_tokens ?? 0; t.cacheMiss += c.usage?.prompt_cache_miss_tokens ?? 0;
    t.reasoning += c.reasoningTokens ?? 0; t.reasoningUnknown += c.reasoningTokens === null || c.reasoningTokens === undefined ? 1 : 0;
    return t;
}, { input: 0, output: 0, cacheHit: 0, cacheMiss: 0, reasoning: 0, reasoningUnknown: 0 });
const reasoning = {
    callsWithReasoning: calls.filter(c => c.reasoning).length,
    callsWithNotation: calls.filter(c => /§/.test(c.reasoning)).length,
    exactReplayParts: rows.filter(r => r.reasoning && r.reasoningReplays?.some((parts: string[]) => parts.includes(r.reasoning))).length,
    emptyReplays: rows.filter(r => r.reasoning && r.reasoningReplays?.some((parts: string[]) => parts.length === 0 || parts.every(p => !p))).length,
    lengthLimits: calls.filter(c => c.finish === "length").map(c => ({ cohort: c.cohort, index: c.index })),
};
const result = { pooled, buckets, firstMixed, usage, calls: calls.length, reasoning,
    estimatedOffPeakUSD: (usage.cacheHit * 0.003 + usage.cacheMiss * 0.15 + usage.output * 0.6) / 1e6,
    estimatedPeakUSD: (usage.cacheHit * 0.006 + usage.cacheMiss * 0.3 + usage.output * 1.2) / 1e6 };
writeFileSync(`${base}-all-${suffix}.jsonl`, rows.map(r => JSON.stringify(r)).join("\n") + "\n");
writeFileSync(`${base}-aggregate-${suffix}.json`, JSON.stringify(result, null, 2));
const folder = `${base}-trajectories-${suffix}`;
mkdirSync(folder, { recursive: true });
for (const s of sessions) {
    let text = `# ${s.variant} ${s.scenario} replicate ${s.replicate}\n\nSession: ${s.session}; cohort: ${s.cohort}\n`;
    for (let turn = 1; turn <= s.prompts.length; turn++) {
        text += `\n## User turn ${turn}\n\n${s.prompts[turn - 1]}\n`;
        for (const r of rows.filter(r => r.session === s.session && r.userTurn === turn)) {
            text += `\n### Reply ${r.position}, text part ${r.partID ?? "none"}\n\nAssigned tag: ${r.assignedTag ?? "none"}; correct: ${r.correct}; byte-identical: ${r.byteIdentity}; malformed: ${r.malformed}; misplaced: ${r.misplaced}; finish: ${r.finish}; reasoning tokens: ${r.reasoningTokens ?? "not reported"}\n\nRaw reply text (JSON string):\n\n\`\`\`json\n${JSON.stringify(r.raw)}\n\`\`\`\n\nTool calls:\n\n\`\`\`json\n${JSON.stringify(r.providerToolCalls, null, 2)}\n\`\`\`\n`;
            if (r.reasoning) text += `\nReasoning (JSON string; not scored):\n\n\`\`\`json\n${JSON.stringify(r.reasoning)}\n\`\`\`\n`;
        }
    }
    writeFileSync(`${folder}/${s.variant.toLowerCase()}-${s.scenario}-${s.replicate}-${s.cohort}.md`, text);
}
console.log(JSON.stringify(result, null, 2));
