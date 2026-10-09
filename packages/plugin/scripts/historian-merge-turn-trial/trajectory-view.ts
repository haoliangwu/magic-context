// Renders the full historian trajectory of merge-turn trial cases as one
// self-contained HTML page: the system prompt, the turn-1 user prompt split
// into its blocks, the model's turn-1 output and extracted facts, the
// candidate memories retrieved for each fact, the turn-2 prompt and reply,
// the parsed decisions, and the reviewer's judgement of each decision.
//
// The trial's raw material holds real prompts and memory text, so the page is
// written outside the repository, under the private trial root, never into git.
//
// Usage: bun trajectory-view.ts <trial root> <case,case,...> [out.html]
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { ROOT } from "./core";
import { V2_ROOT } from "./v2";

const [rootArg, casesArg, outArg] = process.argv.slice(2);
if (!rootArg || !casesArg) {
    console.error("usage: bun trajectory-view.ts <trial root> <case,case,...> [out.html]");
    process.exit(2);
}
const root = resolve(rootArg);
if (![ROOT, V2_ROOT].includes(root)) throw new Error("Root outside private trial fences");
const cases = casesArg.split(",").map((value) => Number(value.trim()));
if (cases.some(index => !Number.isInteger(index) || index < 0 || index >= 40)) throw new Error("Invalid case index");
const out = outArg ? resolve(outArg) : join(root, `trajectory-${cases.join("-")}.html`);
if (!out.startsWith(root + "/")) throw new Error("Output must stay inside the private trial root");
const repo = resolve(import.meta.dir, "../../../..");

const readJson = (path: string) => JSON.parse(readFileSync(path, "utf8"));
const escape = (text: string) =>
    text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const tokens = (text: string) => Math.round(text.length / 4).toLocaleString("en-US");

const systemPrompt = readFileSync(join(repo, "crates/mc-module/testdata/historian-system-prompt.txt"), "utf8");
const judgments = readJson(join(root, "judgments.json"));

/** A collapsible block; large text stays closed until the reader opens it. */
function block(title: string, body: string, open = false): string {
    return `<details${open ? " open" : ""}><summary>${escape(title)} <span class="size">${body.length.toLocaleString("en-US")} chars · ~${tokens(body)} tok</span></summary><pre>${escape(body)}</pre></details>`;
}

/** Splits the user prompt at its top-level XML blocks so each can be opened alone. */
function promptBlocks(prompt: string): string {
    const parts: string[] = [];
    const pattern = /<([a-z_-]+)>[\s\S]*?<\/\1>/g;
    let cursor = 0;
    for (const match of prompt.matchAll(pattern)) {
        const between = prompt.slice(cursor, match.index).trim();
        if (between) parts.push(block("(text between blocks)", between));
        parts.push(block(`<${match[1]}>`, match[0]));
        cursor = (match.index ?? 0) + match[0].length;
    }
    const tail = prompt.slice(cursor).trim();
    if (tail) parts.push(block("(trailing text)", tail));
    return parts.join("\n");
}

const gradeClass = (grade: string) => `grade-${grade}`;

function renderV2(index: number): string {
    return ["A", "B", "C"].map(pass => {
        const dir = join(root, "v2-results", pass);
        if (!existsSync(join(dir, `${index}-decisions.json`))) return "";
        const candidates = readJson(join(dir, `${index}-candidates.json`));
        const reply = readJson(join(dir, `${index}-turn2.json`));
        const prior = readJson(join(dir, `${index}-prior.json`));
        const decisions = readJson(join(dir, `${index}-decisions.json`));
        const observed = JSON.parse(reply.text.trim().replace(/^```(?:json)?\s*/, "").replace(/\s*```$/, ""));
        const judgmentPath = join(root, `v2-judgments-${pass}.json`);
        const reviewed = existsSync(judgmentPath) ? readJson(judgmentPath).decisions : [];
        const rows = candidates.facts.map((fact: { category: string; content: string }, i: number) => {
            const gate = decisions.gates.find((g: { proposed: { fact: number } }) => g.proposed.fact === i + 1);
            // Invalid batches are never repaired for execution. Display raw
            // proposals by output position, separately from the safe fallback.
            const d = decisions.schemaError ? observed[i] : gate.proposed;
            const j = reviewed.find((r: { case: number; fact: number }) => r.case === index && r.fact === i + 1);
            const matches = candidates.matches[i].map((m: any, rank: number) => `<tr${m.id === d.target ? ' class="target"' : ""}><td>${rank + 1}</td><td>#${m.id}</td><td>${escape(m.category)}</td><td>${escape(m.source_type)}</td><td>${((candidates.before - m.created_at) / 86400000).toFixed(1)} days</td><td>${m.hybridScore.toFixed(6)}</td><td>${escape(m.content)}</td></tr>`).join("");
            return `<section class="fact"><h4>V2 fact ${i + 1} · ${escape(fact.category)}</h4><p>${escape(fact.content)}</p>
<details><summary>${candidates.matches[i].length} ranked candidates actually shown</summary><table><tr><th>rank</th><th>id</th><th>category</th><th>source</th><th>age</th><th>hybrid</th><th>text</th></tr>${matches}</table></details>
<p><b>Proposed:</b> ${escape(d.action)}${d.target ? ` #${d.target}` : ""} · ${escape(d.reason)}</p>
${block("Claim inventory", JSON.stringify(d.claims, null, 2), true)}
${d.text ? block("Complete proposed rewrite", d.text, true) : ""}
<div class="judgment ${gate.rejected ? "grade-wrong" : "grade-correct"}"><b>Gate:</b> ${gate.rejected ? "REJECTED → new" : "accepted"} · ${escape(gate.violations.join("; "))}</div>
<p><b>Effective:</b> ${escape(gate.effective.action)}${gate.effective.target ? ` #${gate.effective.target}` : ""}</p>
<div class="judgment ${gradeClass(j?.grade ?? "none")}"><b>Reviewer (effective):</b> ${escape(j?.grade ?? "not judged")} · ${escape(j?.reason ?? "")}</div>
${j?.proposedGrade ? `<p><b>Reviewer (proposed):</b> ${escape(j.proposedGrade)}</p>` : ""}</section>`;
        }).join("\n");
        return `<h3>V2 pass ${pass} · independently imported first-turn exchange</h3><p>Prior mode: ${escape(prior.mode)}; recorded first run ${escape(prior.firstRunId)}. Neither the v1 second turn nor any other v2 answer is in this lineage.</p>
${decisions.schemaError ? `<p class="judgment grade-wrong"><b>Batch schema rejection:</b> ${escape(decisions.schemaError)}. Raw proposals below are linked by array position for review only, not repaired or accepted decisions. Every effective action is new.</p>` : ""}
${block("V2 second-turn user prompt", candidates.prompt)}
<p class="meta">${reply.usage.input_tokens.toLocaleString("en-US")} uncached input · ${(reply.usage.cached_input_tokens ?? 0).toLocaleString("en-US")} reported cached input (absent means unknown) · ${reply.usage.output_tokens.toLocaleString("en-US")} output · ${(reply.durationMs / 1000).toFixed(1)} s</p>
${block("V2 raw second-turn reply", reply.text)}${rows}`;
    }).join("\n");
}

function renderCase(index: number): string {
    const input = readJson(join(root, "inputs", `${index}.json`));
    const turn1 = readJson(join(root, "results", `${index}-turn1.json`));
    const turn2 = readJson(join(root, "results", `${index}-turn2.json`));
    const candidates = readJson(join(root, "results", `${index}-candidates.json`));
    const decisions = readJson(join(root, "results", `${index}-decisions.json`)).decisions;
    const caseJudgments = judgments.decisions.filter((entry: { case: number }) => entry.case === index);

    const factRows = candidates.facts
        .map((fact: { category: string; content: string }, factIndex: number) => {
            const decision = decisions.find((entry: { fact: number }) => entry.fact === factIndex + 1);
            const judged = caseJudgments.find((entry: { fact: number }) => entry.fact === factIndex + 1);
            const matches = candidates.matches[factIndex]
                .map(
                    (match: { id: number; category: string; content: string; lane: string; score: number }) =>
                        `<tr${decision?.target === match.id ? ' class="target"' : ""}><td>#${match.id}</td><td>${match.lane}</td><td>${match.score.toFixed(3)}</td><td>${match.category}</td><td>${escape(match.content)}</td></tr>`,
                )
                .join("");
            return `<section class="fact">
<h4>Fact ${factIndex + 1} <span class="cat">${fact.category}</span></h4>
<p class="fact-text">${escape(fact.content)}</p>
<details><summary>20 candidate memories shown to the model (semantic + lexical)</summary>
<table><tr><th>id</th><th>lane</th><th>score</th><th>category</th><th>memory text</th></tr>${matches}</table></details>
<div class="decision"><b>Model decision:</b> ${escape(decision?.action ?? "missing")}${decision?.target ? ` #${decision.target}` : ""}
${decision?.text ? `<div><b>Proposed text:</b> ${escape(decision.text)}</div>` : ""}
<div><b>Model's reason:</b> ${escape(decision?.reason ?? "")}</div></div>
<div class="judgment ${gradeClass(judged?.grade ?? "none")}"><b>Reviewer:</b> ${escape(judged?.grade ?? "not judged")} · ${escape(judged?.reason ?? "")}</div>
</section>`;
        })
        .join("\n");

    return `<article id="case-${index}">
<h2>Case ${index} · historian session ${escape(input.session)}</h2>
<p class="meta">Original prompt ${input.originalChars.toLocaleString("en-US")} chars (~${input.originalEstimatedTokens.toLocaleString("en-US")} tok), of which the project-memory block was ~${input.memoryEstimatedTokens.toLocaleString("en-US")} tok. Replay prompt without it: ${input.strippedChars.toLocaleString("en-US")} chars (~${input.strippedEstimatedTokens.toLocaleString("en-US")} tok). Memory pool for matching: ${candidates.poolSize} memories that existed before this run.</p>

<h3>Step 1 · What the historian received</h3>
${block("System prompt (production historian prompt)", systemPrompt)}
<h4>User prompt, block by block (project-memory block removed)</h4>
${promptBlocks(input.prompt)}

<h3>Step 2 · Historian output, turn 1 <span class="size">${turn1.usage.input_tokens.toLocaleString("en-US")} in · ${turn1.usage.output_tokens.toLocaleString("en-US")} out · ${(turn1.durationMs / 1000).toFixed(1)} s</span></h3>
${block("Turn-1 reply (compartments + facts)", turn1.text, true)}
${block("For comparison: what the historian wrote originally, with the memory block", input.originalOutput)}

<h3>Step 3 · What we did next: look up the nearest memories for each emitted fact</h3>
<p>Each fact was embedded and matched against the memory pool (15 semantic matches plus 5 distinct lexical BM25 matches). Those 20 candidates went into turn 2.</p>

<h3>Step 4 · What the historian received in turn 2 (same session, continuation)</h3>
${block("Turn-2 user message", candidates.prompt)}

<h3>Step 5 · Historian output, turn 2 <span class="size">${turn2.usage.input_tokens.toLocaleString("en-US")} in · ${turn2.usage.output_tokens.toLocaleString("en-US")} out · ${(turn2.durationMs / 1000).toFixed(1)} s</span></h3>
${block("Turn-2 reply (raw)", turn2.text, true)}

<h3>Step 6 · Per fact: candidates, decision, and the reviewer's judgement</h3>
${factRows}
${renderV2(index)}
</article>`;
}

const page = `<!doctype html><html><head><meta charset="utf-8"><title>Historian trajectory · cases ${cases.join(", ")}</title>
<style>
body{font:14px/1.5 -apple-system,system-ui,sans-serif;background:#0f1115;color:#d8dbe2;margin:0;padding:24px 40px;max-width:1500px}
h2{border-top:2px solid #2d3340;padding-top:20px;margin-top:40px;color:#fff}h3{color:#7fb0ff;margin-top:28px}
details{background:#171a21;border:1px solid #262b36;border-radius:6px;margin:6px 0}summary{cursor:pointer;padding:6px 10px;font-weight:600}
pre{white-space:pre-wrap;word-break:break-word;margin:0;padding:10px 14px;font:12px/1.45 ui-monospace,Menlo,monospace;max-height:70vh;overflow:auto;border-top:1px solid #262b36}
.size{font-weight:400;color:#8a92a3;font-size:12px}.meta{color:#a5adbd}
.fact{border:1px solid #262b36;border-radius:6px;padding:10px 14px;margin:12px 0;background:#141720}.fact-text{margin:4px 0 8px}
.cat{font-size:11px;background:#262b36;padding:1px 6px;border-radius:4px;color:#a5adbd}
table{border-collapse:collapse;width:100%;font-size:12px}td,th{border-top:1px solid #262b36;padding:4px 6px;vertical-align:top;text-align:left}tr.target{background:#2a2410}
.decision{margin-top:8px}.judgment{margin-top:6px;padding:4px 8px;border-radius:4px}
.grade-correct{background:#12301c}.grade-wrong{background:#3a1416}.grade-debatable{background:#33290f}
nav a{color:#7fb0ff;margin-right:12px}
</style></head><body>
<h1>Historian merge-turn trajectories</h1>
<p>Trial: the historian runs without the project-memory block (turn 1), then decides for each emitted fact whether it is new, already covered, or should merge, update or replace an existing memory (turn 2). Model: Gemini 3.8 Flash. Highlighted rows in a candidate table are the memory the decision targets.</p>
<nav>${cases.map((index) => `<a href="#case-${index}">Case ${index}</a>`).join("")}</nav>
${cases.map(renderCase).join("\n")}
</body></html>`;

writeFileSync(out, page, { mode: 0o600 });
console.log(out);
