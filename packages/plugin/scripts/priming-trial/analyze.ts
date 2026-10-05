// Turns one or more priming-trial run roots into per-bucket measures, a summary
// JSON and a scrubbed trajectory per run.
//
//   bun scripts/priming-trial/analyze.ts --out <dir> <label>=<run root> [...]
//
// Every measure is computed from what the model actually produced (the relay's
// view of the provider stream) against the request it answered.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import type { RelayCall } from "./relay";
import { classifyLeadingTag, isMarkerOnlyOutput, measureExposure, placeholderHits } from "./placeholder";

type Turn = { turn: number; prompt: string; durationMs: number; calls: number[]; error?: string; timedOut?: boolean };
type HostEvent = { at: number; kind: string; tool?: string; args?: string; refused?: string; text?: string };

const BUCKET = 25;
const readJsonl = <T>(path: string): T[] =>
    existsSync(path) ? readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as T) : [];

const hasHits = (hits: Record<string, number>) => Object.keys(hits).length > 0;
const TAG_IN_TEXT = /§\s*\d+\s*§/;
const TAG_ONLY = /^\s*(?:§\d+§\s*)+$/;

export type Measures = {
    turns: number;
    replies: number;
    tagCorrect: number;
    tagWrong: number;
    tagMissing: number;
    placeholderTexts: number;
    placeholderShapes: Record<string, number>;
    placeholderReasoning: number;
    markerOnlyTexts: number;
    markerOnlyWithPlaceholder: number;
    /** Text parts holding nothing but a tag, such as `§40§` alone. */
    tagOnlyTexts: number;
    /** Tag-only text parts written alongside tool calls in the same reply. */
    tagOnlyBeforeTool: number;
    /** Replies that open with a tag and carry real text after it. */
    taggedRealReplies: number;
    toolCalls: number;
    toolCallsWithPlaceholder: number;
    toolCallsWithTag: number;
    guardRefusals: number;
    dropsInContextMax: number;
    dropsInContextEnd: number;
    droppedTagsEnd: number;
    mainCalls: number;
    auxCalls: number;
    cacheBusts: number;
    promptTokens: number;
    cachedTokens: number;
    turnSecondsMedian: number;
    turnSecondsMean: number;
    turnErrors: number;
};

const emptyMeasures = (): Measures => ({
    turns: 0, replies: 0, tagCorrect: 0, tagWrong: 0, tagMissing: 0, placeholderTexts: 0, placeholderShapes: {},
    placeholderReasoning: 0, markerOnlyTexts: 0, markerOnlyWithPlaceholder: 0, tagOnlyTexts: 0, tagOnlyBeforeTool: 0,
    taggedRealReplies: 0, toolCalls: 0, toolCallsWithPlaceholder: 0,
    toolCallsWithTag: 0, guardRefusals: 0, dropsInContextMax: 0, dropsInContextEnd: 0, droppedTagsEnd: 0, mainCalls: 0,
    auxCalls: 0, cacheBusts: 0, promptTokens: 0, cachedTokens: 0, turnSecondsMedian: 0, turnSecondsMean: 0, turnErrors: 0,
});

const dropsIn = (call: RelayCall) =>
    call.exposure.droppedToolResults + call.exposure.droppedToolInputs + call.exposure.droppedTextParts;

/** A main-lane call whose prompt was mostly re-processed although a long prefix existed before it. */
export function isCacheBust(call: RelayCall, previous: RelayCall | undefined): boolean {
    const prompt = call.usage?.prompt_tokens ?? 0;
    const cached = call.usage?.prompt_tokens_details?.cached_tokens ?? call.timings?.cache_n ?? 0;
    if (!previous || prompt < 4000) return false;
    return cached < 0.5 * (previous.usage?.prompt_tokens ?? 0);
}

/** Reads the request a call answered, exactly as it was sent upstream. */
function requestBody(root: string, index: number): any | undefined {
    const path = join(root, "bodies", `${String(index).padStart(5, "0")}.json.gz`);
    return existsSync(path) ? JSON.parse(new TextDecoder().decode(Bun.gunzipSync(readFileSync(path)))) : undefined;
}

function loadCalls(root: string): Map<number, RelayCall> {
    const calls = readJsonl<RelayCall>(join(root, "calls.jsonl"));
    // Exposure is recomputed from the stored request so every run is measured by
    // the same rules, whatever version of the relay recorded it.
    for (const call of calls) {
        const body = requestBody(root, call.index);
        if (body) call.exposure = measureExposure(body);
    }
    return new Map(calls.map((call) => [call.index, call]));
}

export function analyzeRun(root: string) {
    const turns = readJsonl<Turn>(join(root, "turns.jsonl"));
    const calls = loadCalls(root);
    const host = readJsonl<HostEvent>(join(root, "host-capture.jsonl"));
    const refusals = host.filter((event) => event.kind === "tool" && event.refused);
    const firstSeen: Record<string, number> = {};
    const seen = (name: string, turn: number) => {
        firstSeen[name] ??= turn;
    };
    const excerpts: { turn: number; call: number; kind: string; text: string }[] = [];
    const buckets = new Map<number, Measures>();
    const overall = emptyMeasures();
    const durations: Record<number, number[]> = {};
    let previousMain: RelayCall | undefined;
    const ordered = [...calls.values()].sort((a, b) => a.index - b.index);
    const turnOf = new Map<number, number>();
    for (const turn of turns) for (const index of turn.calls) turnOf.set(index, turn.turn);
    for (const turn of turns) {
        const bucket = Math.ceil(turn.turn / BUCKET);
        const m = buckets.get(bucket) ?? emptyMeasures();
        buckets.set(bucket, m);
        for (const target of [m, overall]) {
            target.turns++;
            if (turn.error || turn.timedOut) target.turnErrors++;
        }
        (durations[bucket] ??= []).push(turn.durationMs / 1000);
        (durations[0] ??= []).push(turn.durationMs / 1000);
        if (turn.error || turn.timedOut) seen("turn-error", turn.turn);
    }
    for (const call of ordered) {
        const turnNumber = turnOf.get(call.index) ?? call.turn;
        const bucket = Math.max(1, Math.ceil(turnNumber / BUCKET));
        const m = buckets.get(bucket) ?? emptyMeasures();
        buckets.set(bucket, m);
        const targets = [m, overall];
        if (call.lane === "aux") {
            for (const t of targets) t.auxCalls++;
            continue;
        }
        const bust = isCacheBust(call, previousMain);
        previousMain = call;
        const drops = dropsIn(call);
        for (const t of targets) {
            t.mainCalls++;
            t.promptTokens += call.usage?.prompt_tokens ?? 0;
            t.cachedTokens += call.usage?.prompt_tokens_details?.cached_tokens ?? 0;
            if (bust) t.cacheBusts++;
            t.dropsInContextMax = Math.max(t.dropsInContextMax, drops);
            t.dropsInContextEnd = drops;
            t.droppedTagsEnd = call.exposure.droppedTags;
        }
        if (drops > 0) seen("drops-in-context", turnNumber);
        if (bust) seen("cache-bust", turnNumber);
        const text = call.text;
        if (text.trim()) {
            const lead = classifyLeadingTag(text, call.exposure.maxTag);
            const hits = placeholderHits(text);
            const markerOnly = isMarkerOnlyOutput(text);
            const tagOnly = TAG_ONLY.test(text);
            for (const t of targets) {
                if (tagOnly) t.tagOnlyTexts++;
                if (tagOnly && call.toolCalls.length) t.tagOnlyBeforeTool++;
                if (lead.kind !== "missing" && !markerOnly) t.taggedRealReplies++;
                t.replies++;
                if (lead.kind === "correct") t.tagCorrect++;
                else if (lead.kind === "wrong") t.tagWrong++;
                else t.tagMissing++;
                if (hasHits(hits)) {
                    t.placeholderTexts++;
                    for (const [name, count] of Object.entries(hits)) t.placeholderShapes[name] = (t.placeholderShapes[name] ?? 0) + count;
                }
                if (markerOnly) t.markerOnlyTexts++;
                if (markerOnly && hasHits(hits)) t.markerOnlyWithPlaceholder++;
            }
            if (lead.kind !== "missing") seen("leading-tag", turnNumber);
            if (tagOnly) {
                seen("tag-only-text", turnNumber);
                excerpts.push({ turn: turnNumber, call: call.index, kind: "tag-only-text", text: `${text}${call.toolCalls.length ? ` <then ${call.toolCalls.map((tool) => tool.name).join(", ")}>` : ""}` });
            }
            if (lead.kind === "wrong") seen("leading-tag-wrong", turnNumber);
            if (hasHits(hits)) {
                seen("placeholder-in-text", turnNumber);
                excerpts.push({ turn: turnNumber, call: call.index, kind: "placeholder-in-text", text });
            }
            if (markerOnly && !tagOnly) {
                seen("marker-only-text", turnNumber);
                if (hasHits(hits)) seen("marker-only-placeholder-text", turnNumber);
                excerpts.push({ turn: turnNumber, call: call.index, kind: "marker-only-text", text });
            }
        }
        if (hasHits(placeholderHits(call.reasoning))) {
            for (const t of targets) t.placeholderReasoning++;
            seen("placeholder-in-reasoning", turnNumber);
        }
        for (const tool of call.toolCalls) {
            const argHits = placeholderHits(tool.arguments);
            const argTag = TAG_IN_TEXT.test(tool.arguments);
            for (const t of targets) {
                t.toolCalls++;
                if (hasHits(argHits)) t.toolCallsWithPlaceholder++;
                if (argTag) t.toolCallsWithTag++;
            }
            if (hasHits(argHits)) {
                seen("placeholder-in-tool-args", turnNumber);
                excerpts.push({ turn: turnNumber, call: call.index, kind: "placeholder-in-tool-args", text: `${tool.name} ${tool.arguments}` });
            }
            if (argTag) seen("tag-in-tool-args", turnNumber);
        }
    }
    // A refusal happens while the tool call that carried it executes, so it belongs
    // to the newest main-lane call that started before it.
    for (const refusal of refusals) {
        const owner = ordered.filter((call) => call.lane === "main" && call.startedAt <= refusal.at).at(-1);
        const turnNumber = owner ? (turnOf.get(owner.index) ?? owner.turn) : 0;
        excerpts.push({ turn: turnNumber, call: owner?.index ?? 0, kind: "guard-refusal", text: `${refusal.tool} ${refusal.args}` });
        const bucket = Math.max(1, Math.ceil(turnNumber / BUCKET));
        for (const t of [buckets.get(bucket) ?? emptyMeasures(), overall]) t.guardRefusals++;
        seen("guard-refusal", turnNumber);
    }
    const stats = (values: number[]) => {
        const sorted = [...values].sort((a, b) => a - b);
        return {
            median: sorted.length ? sorted[Math.floor(sorted.length / 2)]! : 0,
            mean: sorted.length ? sorted.reduce((a, b) => a + b, 0) / sorted.length : 0,
        };
    };
    for (const [bucket, m] of buckets) {
        const s = stats(durations[bucket] ?? []);
        m.turnSecondsMedian = Math.round(s.median);
        m.turnSecondsMean = Math.round(s.mean);
    }
    const s = stats(durations[0] ?? []);
    overall.turnSecondsMedian = Math.round(s.median);
    overall.turnSecondsMean = Math.round(s.mean);
    const auxCalls = ordered.filter((call) => call.lane === "aux");
    const historianLog = existsSync(join(root, "magic-context.log")) ? readFileSync(join(root, "magic-context.log"), "utf8") : "";
    const countLog = (pattern: RegExp) => historianLog.match(pattern)?.length ?? 0;
    const historian = {
        started: countLog(/historian: creating child session/g),
        promptCompleted: countLog(/historian: prompt completed/g),
        promptFailed: countLog(/historian prompt failed/g),
        invalidOutput: countLog(/stage=validate status=failed/g),
        validated: countLog(/stage=validate status=completed/g),
        invalidReasons: [...historianLog.matchAll(/stage=validate status=failed[^\n]*reason="([^"\n]{0,140})/g)].map((m) => m[1]),
    };
    return {
        historian,
        overall,
        buckets: Object.fromEntries([...buckets.entries()].sort((a, b) => a[0] - b[0])),
        firstSeen,
        excerpts,
        aux: {
            calls: auxCalls.length,
            seconds: Math.round(auxCalls.reduce((sum, call) => sum + (call.durationMs ?? 0), 0) / 1000),
            heads: [...new Set(auxCalls.map((call) => (call.systemHead ?? "").slice(0, 80)))],
        },
        totalHours: Number((turns.reduce((sum, turn) => sum + turn.durationMs, 0) / 3_600_000).toFixed(2)),
    };
}

/** Removes local paths and anything shaped like a key before a trajectory is written to the repository. */
export function scrub(text: string, root: string): string {
    const normalized = resolve(root);
    return text
        .replaceAll(`/private${normalized}`, "<run>")
        .replaceAll(normalized, "<run>")
        .replaceAll(root, "<run>")
        .replace(/(?:\/private)?\/var\/folders\/\S*?\/issue-563-priming\/[\w-]+/g, "<run>")
        // A path cut short by clipping no longer matches the run root above.
        .replace(/(?:\/private)?\/var\/folders\/[^\s"'\\]*/g, "<tmp>")
        .replace(/\/Users\/[^/\s]+/g, "<home>")
        .replace(/sk-[A-Za-z0-9_-]{8,}/g, "[REDACTED]")
        .replace(/Bearer\s+\S+/g, "Bearer [REDACTED]");
}

const clip = (text: string, limit: number) => (text.length > limit ? `${text.slice(0, limit)} …[+${text.length - limit} chars]` : text);

function toolResultsFor(root: string, nextIndex: number): string[] {
    const body = requestBody(root, nextIndex);
    if (!body) return [];
    const messages: any[] = body.messages ?? [];
    const results: string[] = [];
    for (let i = messages.length - 1; i >= 0 && messages[i].role === "tool"; i--) {
        const content = messages[i].content;
        results.unshift(typeof content === "string" ? content : JSON.stringify(content));
    }
    return results;
}

export function trajectory(root: string, label: string): string {
    const turns = readJsonl<Turn>(join(root, "turns.jsonl"));
    const calls = loadCalls(root);
    const mainIndices = [...calls.values()].filter((call) => call.lane === "main").map((call) => call.index).sort((a, b) => a - b);
    const lines = [
        `# Trajectory: ${label}`,
        "",
        "One run of the issue 563 priming trial (see docs/reports/issue-563-priming-trial.md). Each turn lists the scripted user prompt and every model call made while answering it.",
        "",
        "- Assistant text is verbatim from the provider stream, including the `§N§` tag Magic Context's guidance asks the model to write at the start of a reply. Tool results carry the tags Magic Context assigned.",
        "- `visible max tag`: the highest tag at the start of any message in the request; a correct reply tag is one more.",
        "- `drops in context`: drop placeholders (`[dropped §N§]`) present in the request.",
        "- `prompt N (cached M)`: prompt tokens, and how many the server served from its prefix cache.",
        "- `finish`: `tool_calls` when the model called tools, `stop` when it ended its turn.",
        "- `aux call`: a call Magic Context's historian made to the same model to summarize older history.",
        "- Tool arguments are clipped to 300 characters and tool results to 240. Local paths are replaced with `<run>`, `<tmp>` and `<home>`.",
        "",
    ];
    for (const turn of turns) {
        lines.push(`## Turn ${turn.turn} (${Math.round(turn.durationMs / 1000)} s)`, "", `**User:** ${turn.prompt}`, "");
        if (turn.error) lines.push(`**Turn error:** ${turn.error}`, "");
        if (turn.timedOut) lines.push("**Turn timed out and was aborted.**", "");
        for (const index of turn.calls) {
            const call = calls.get(index);
            if (!call) continue;
            if (call.lane === "aux") {
                lines.push(`- _aux call ${index} (${Math.round((call.durationMs ?? 0) / 1000)} s): ${(call.systemHead ?? "").slice(0, 60)}…_`);
                continue;
            }
            const e = call.exposure;
            const cached = call.usage?.prompt_tokens_details?.cached_tokens ?? "?";
            lines.push(
                `- call ${index} · ${Math.round((call.durationMs ?? 0) / 1000)} s · prompt ${call.usage?.prompt_tokens ?? "?"} (cached ${cached}) · visible max tag ${e.maxTag} · drops in context ${dropsIn(call)} · finish ${call.finish ?? call.error ?? "?"}`,
            );
            if (call.text) lines.push("", "  ```text", ...clip(call.text, 2000).split("\n").map((line) => `  ${line}`), "  ```");
            for (const tool of call.toolCalls) lines.push(`  - tool \`${tool.name}\` ${clip(tool.arguments, 300).replaceAll("\n", "\\n")}`);
            const next = mainIndices.find((candidate) => candidate > index);
            if (call.toolCalls.length && next !== undefined)
                for (const result of toolResultsFor(root, next))
                    lines.push(`    - result: ${clip(result, 240).replaceAll("\n", "\\n")}`);
            lines.push("");
        }
    }
    return scrub(lines.join("\n"), root);
}

if (import.meta.main) {
    const { values, positionals } = parseArgs({ options: { out: { type: "string" } }, allowPositionals: true });
    if (!values.out) throw new Error("--out is required");
    mkdirSync(values.out, { recursive: true });
    const summary: Record<string, unknown> = {};
    for (const spec of positionals) {
        const [label, root] = spec.split("=") as [string, string];
        const result = analyzeRun(root);
        summary[label] = { ...result, excerpts: result.excerpts.map((excerpt) => ({ ...excerpt, text: scrub(excerpt.text, root) })) };
        writeFileSync(join(values.out, `${label}.md`), trajectory(root, label));
    }
    writeFileSync(join(values.out, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
    console.log(JSON.stringify(Object.fromEntries(Object.entries(summary).map(([k, v]: [string, any]) => [k, { overall: v.overall, firstSeen: v.firstSeen, totalHours: v.totalHours, aux: v.aux }])), null, 2));
}
