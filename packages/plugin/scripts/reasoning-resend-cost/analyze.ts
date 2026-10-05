import { Database } from "bun:sqlite";
import { createReadStream, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import { createInterface } from "node:readline";
import {
    estimateTokens,
    getTokenEstimatorFingerprint,
    preloadTokenizer,
} from "../../src/hooks/magic-context/read-session-formatting";
import {
    CALIBRATION_TABLE_REVISION,
    resolveModelCalibration,
} from "../../src/hooks/magic-context/tokenizer-calibration";
import { exampleIndices, fit, fitLag, type Observation, quantile } from "./math";

type Json = Record<string, unknown>;
export interface Usage { input: number; output: number; reasoning: number | null; read: number; write: number }
interface Step {
    id: string; session: string; provider: string; model: string; usage: Usage;
    time: number; bad: boolean;
}
export interface Content {
    bodies: string[]; reasoning: string[]; visible: string[];
    tools: number; users: number; unsupported: boolean; replayChars: number;
}
interface Pair extends Observation {
    id: string; nextId: string; usage: Usage; nextUsage: Usage;
    gap: number; users: number; tools: number; reasoningLocal: number;
    visibleLocal: number; replayChars: number; basis: string; prior: number | null;
}
interface Group {
    steps: number; reportedReasoningSteps: number; candidates: number;
    exclusions: Record<string, number>; rows: Pair[];
}
const object = (v: unknown): Json => v && typeof v === "object" ? v as Json : {};
const array = (v: unknown): unknown[] => Array.isArray(v) ? v : [];
const text = (v: unknown): string => typeof v === "string" ? v : "";
const number = (v: unknown): number => typeof v === "number" && Number.isFinite(v) ? v : 0;
export const total = (u: Usage): number => u.input + u.read + u.write;
const groups = new Map<string, Group>();
let since = Date.parse("2026-09-27T00:00:00Z");
let until = Date.parse("2026-10-04T23:59:59.999Z");
const inventory: Json[] = [];

function group(harness: string, step: Step): Group {
    const key = `${harness}|${step.provider}/${step.model}`;
    let g = groups.get(key);
    if (!g) {
        g = { steps: 0, reportedReasoningSteps: 0, candidates: 0, exclusions: {}, rows: [] };
        groups.set(key, g);
    }
    return g;
}
function exclude(g: Group, why: string) { g.exclusions[why] = (g.exclusions[why] ?? 0) + 1; }
function usage(raw: unknown): Usage {
    const t = object(raw), cache = object(t.cache);
    return {
        input: number(t.input), output: number(t.output),
        reasoning: typeof t.reasoning === "number" ? number(t.reasoning) : null,
        read: number(cache.read ?? t.cacheRead), write: number(cache.write ?? t.cacheWrite),
    };
}
function blank(): Content {
    return { bodies: [], reasoning: [], visible: [], tools: 0, users: 0, unsupported: false, replayChars: 0 };
}
function stringify(v: unknown): string { return typeof v === "string" ? v : JSON.stringify(v) ?? ""; }

/** OpenCode 1 stores tool results on the producing assistant, not as user rows. */
export function oc1Content(parts: unknown[], assistant: boolean): Content {
    const c = blank();
    for (const raw of parts) {
        const p = object(raw), type = text(p.type);
        if (type === "reasoning") {
            c.reasoning.push(text(p.text));
            c.replayChars += number(p.metadataChars);
        } else if (type === "text" && p.ignored !== true) {
            (assistant ? c.visible : c.bodies).push(text(p.text));
        } else if (type === "tool") {
            const state = object(p.state);
            c.tools++;
            c.visible.push(`${text(p.tool)} ${stringify(state.input)}`);
            if (state.status !== "completed" && state.status !== "error") c.unsupported = true;
            const output = state.status === "error" ? state.error : state.output;
            if (output === undefined) c.unsupported = true;
            else c.bodies.push(stringify(output));
            if (array(state.attachments).length) c.unsupported = true;
        } else if (!["step-start", "step-finish", "snapshot", "patch", "reasoning", "text"].includes(type)) {
            c.unsupported = true;
        }
    }
    if (!assistant) c.users = 1;
    return c;
}
export function piContent(message: Json): Content {
    const c = blank(), role = text(message.role);
    c.users = role === "user" ? 1 : 0;
    c.tools = role === "toolResult" ? 1 : 0;
    const parts = typeof message.content === "string" ? [{ type: "text", text: message.content }] : array(message.content);
    for (const raw of parts) {
        const p = object(raw);
        if (p.type === "thinking") {
            c.reasoning.push(text(p.thinking));
            c.replayChars += text(p.thinkingSignature).length;
        } else if (p.type === "text") {
            (role === "assistant" ? c.visible : c.bodies).push(text(p.text));
        } else if (p.type === "toolCall") {
            c.visible.push(`${text(p.name)} ${stringify(p.arguments)}`);
        } else c.unsupported = true;
    }
    return c;
}
function merge(a: Content, b: Content): Content {
    return {
        bodies: [...a.bodies, ...b.bodies], reasoning: [...a.reasoning, ...b.reasoning],
        visible: [...a.visible, ...b.visible], tools: a.tools + b.tools, users: a.users + b.users,
        unsupported: a.unsupported || b.unsupported, replayChars: a.replayChars + b.replayChars,
    };
}
export function estimatePair(a: Usage, b: Usage, c: Content, ratio: number, outputIncludesReasoning = true) {
    const count = (parts: string[]) => parts.reduce((sum, s) => sum + estimateTokens(s) * ratio, 0);
    const body = count(c.bodies), reasoningLocal = count(c.reasoning), visibleLocal = count(c.visible);
    const wrappers = 12 * c.tools + 8 * c.users;
    // Some providers store reasoning=0 even when reasoning parts contain text.
    // Their output semantics cannot be inferred by subtracting a local text count:
    // use independently tokenized visible text/tool calls on those routes instead.
    const reported = a.reasoning !== null && (a.reasoning > 0 || reasoningLocal === 0);
    // OpenCode stores non-reasoning output separately; Pi's output includes it.
    // Subtracting R from OpenCode's O double-counts R in the estimated replay.
    const visible = reported ? a.output - (outputIncludesReasoning ? (a.reasoning ?? 0) : 0) : visibleLocal;
    const x = reported ? (a.reasoning ?? 0) : reasoningLocal;
    return {
        x, y: total(b) - total(a) - visible - body - wrappers, body, wrappers,
        reasoningLocal, visibleLocal, basis: reported ? "reported" : "text",
    };
}

function addPair(harness: string, a: Step, b: Step, content: () => Content, prior: number | null) {
    if (a.time < since || a.time > until || b.time > until) return;
    const g = group(harness, a);
    g.candidates++;
    if (a.provider !== b.provider || a.model !== b.model) return exclude(g, "model-switch");
    if (a.bad || b.bad || !total(a.usage) || !total(b.usage) || a.usage.output <= 0 || b.usage.output <= 0)
        return exclude(g, "error-or-empty-usage");
    if (harness === "pi" && a.usage.reasoning !== null && a.usage.reasoning > a.usage.output)
        return exclude(g, "reasoning-exceeds-output");
    // Retain gaps up to 512 so exact/128/512-token cache tolerance can be compared
    // without making another pass over the private data. None of these gates proves
    // byte identity of the complete request; cache blocks can hide small tail edits.
    const gap = total(a.usage) - b.usage.read;
    if (gap > 512) return exclude(g, "cache-prefix-gap-over-512");
    const c = content();
    if (c.unsupported) return exclude(g, "nontext-or-unfinished-tool-or-history-edit");
    if (c.bodies.reduce((sum, s) => sum + s.length, 0) > 100_000)
        return exclude(g, "new-content-over-100k-characters");
    const calibration = resolveModelCalibration(a.provider, a.model);
    const e = estimatePair(a.usage, b.usage, c, calibration.proseRatio, harness === "pi");
    g.rows.push({ ...e, id: a.id, nextId: b.id, session: a.session,
        usage: a.usage, nextUsage: b.usage, gap, users: c.users, tools: c.tools,
        replayChars: c.replayChars, prior,
    });
}
function recordStep(harness: string, s: Step) {
    if (s.time < since || s.time > until) return;
    const g = group(harness, s);
    g.steps++;
    if ((s.usage.reasoning ?? 0) > 0) g.reportedReasoningSteps++;
}
function oc1(db: Database) {
    const rows = db.query(`SELECT id,session_id,time_created,
        json_object('role',json_extract(data,'$.role'),
            'providerID',json_extract(data,'$.providerID'),'modelID',json_extract(data,'$.modelID'),
            'tokens',json_extract(data,'$.tokens'),'finish',json_extract(data,'$.finish'),
            'error',json_extract(data,'$.error') IS NOT NULL,'summary',json_extract(data,'$.summary')) AS data
        FROM message
        WHERE time_created >= ? AND time_created <= ? ORDER BY session_id,time_created,id`)
        .all(since, until) as Array<{ id: string; session_id: string; time_created: number; data: string }>;
    // Read only fields required for tokenization, on eligible pairs. Never select
    // replay payloads, auth tables, or full message/part JSON. Private text stays in
    // memory; only its calibrated token counts leave this process.
    const partsQuery = db.query(`SELECT json_object(
        'type',json_extract(data,'$.type'),'text',json_extract(data,'$.text'),
        'ignored',json(CASE WHEN json_extract(data,'$.ignored') THEN 'true' ELSE 'false' END),'tool',json_extract(data,'$.tool'),
        'metadataChars',length(json_extract(data,'$.metadata')),
        'state',json_object('status',json_extract(data,'$.state.status'),
            'input',json_extract(data,'$.state.input'),'output',json_extract(data,'$.state.output'),
            'error',json_extract(data,'$.state.error'),
            'attachments',json(CASE WHEN json_array_length(data,'$.state.attachments') > 0 THEN '[1]' ELSE '[]' END))
        ) AS data FROM part WHERE message_id = ? ORDER BY id`);
    const parts = (id: string) => (partsQuery.all(id) as Array<{ data: string }>).map((p) => JSON.parse(p.data));
    let previous: Step | undefined, pending: string[] = [], blocked = false;
    let prior: number | null = null, session = "";
    for (const row of rows) {
        if (row.session_id !== session) { session = row.session_id; previous = undefined; pending = []; blocked = false; prior = null; }
        const data = object(JSON.parse(row.data));
        if (data.role !== "assistant") {
            if (data.role !== "user") blocked = true;
            else pending.push(row.id);
            continue;
        }
        const s: Step = {
            id: row.id, session, provider: text(data.providerID), model: text(data.modelID),
            usage: usage(data.tokens), time: row.time_created,
            bad: !!data.error || !!data.summary || ["length", "content-filter", "error"].includes(text(data.finish)),
        };
        recordStep("oc1", s);
        if (previous) {
            const a = previous;
            addPair("oc1", a, s, () => {
                let c = oc1Content(parts(a.id), true);
                for (const id of pending) c = merge(c, oc1Content(parts(id), false));
                c.unsupported ||= blocked;
                return c;
            }, prior);
            prior = a.usage.reasoning;
        }
        previous = s; pending = []; blocked = false;
    }
    inventory.push({ harness: "oc1", messageRowsInWindow: rows.length });
}

async function pi(file: string) {
    interface Entry { step?: Step; parent: string; content: Content; barrier: boolean }
    const entries = new Map<string, Entry>();
    let session = file, lines = 0, assistants = 0, reasoningFields = 0;
    const input = createInterface({ input: createReadStream(file), crlfDelay: Infinity });
    for await (const line of input) {
        lines++;
        if (!line.trim()) continue;
        const raw = object(JSON.parse(line)), m = object(raw.message), id = text(raw.id);
        if (raw.type === "session") { session = text(raw.id) || session; continue; }
        const role = text(m.role), time = typeof m.timestamp === "number" ? m.timestamp : Date.parse(text(raw.timestamp));
        const e: Entry = {
            parent: text(raw.parentId), content: piContent(m),
            barrier: ["compaction", "context_edit", "custom_message", "model_change"].includes(text(raw.type)),
        };
        // Entries before the window still establish ancestry, but their text is
        // never needed for a measured pair. This keeps large months-old files small.
        if (time < since) e.content = blank();
        if (raw.type === "message" && role === "assistant") {
            const s: Step = {
                id, session, provider: text(m.provider), model: text(m.model),
                usage: usage(m.usage), time,
                bad: ["error", "aborted", "length"].includes(text(m.stopReason)),
            };
            e.step = s;
            recordStep("pi", s);
            if (time >= since && time <= until) {
                assistants++;
                if (s.usage.reasoning !== null) reasoningFields++;
                let cursor = e.parent, content = blank(), barrier = false;
                while (cursor) {
                    const parent = entries.get(cursor);
                    if (!parent) { barrier = true; break; }
                    barrier ||= parent.barrier;
                    if (parent.step) {
                        const a = parent.step;
                        addPair("pi", a, s, () => {
                            const c = merge(parent.content, content);
                            c.unsupported ||= barrier;
                            return c;
                        }, null);
                        break;
                    }
                    content = merge(parent.content, content);
                    cursor = parent.parent;
                }
            }
        } else if (raw.type === "message" && !["user", "toolResult"].includes(role)) e.barrier = true;
        if (id) entries.set(id, e);
    }
    inventory.push({ harness: "pi", file: file.split(sep).pop(), lines, assistantsInWindow: assistants, reasoningFieldsInWindow: reasoningFields });
}

function oc2(db: Database) {
    // Inspect the actual stored shape before asserting a v1-compatible measurement.
    // A store without assistant rows needs no invented usage/content adapter.
    const counts = db.query(`SELECT type, count(*) AS n FROM session_message GROUP BY type`).all();
    const recent = db.query(`SELECT count(*) AS n FROM session_message
        WHERE type='assistant' AND time_created >= ? AND time_created <= ?`).get(since, until);
    const shapes = db.query(`SELECT json_object('model',json_extract(data,'$.model'),
        'tokens',json_extract(data,'$.tokens'),'usage',json_extract(data,'$.usage'),
        'contentTypes',(SELECT json_group_array(json_extract(value,'$.type')) FROM json_each(data,'$.content'))
        ) AS data FROM session_message WHERE type='assistant' LIMIT 3`).all() as Array<{ data: string }>;
    inventory.push({ harness: "oc2", allTimeTypeCounts: counts, recentAssistantCount: recent,
        assistantShapes: shapes.map((r) => {
            const d = object(JSON.parse(r.data));
            return { keys: Object.keys(d), usage: d.usage ?? d.tokens, model: d.model,
                contentTypes: d.contentTypes };
        }),
    });
    if (number(object(recent).n) > 0) throw new Error("OC2 has recent assistants; inspect its shapes and implement its real store format before measuring");
}

function summarize(key: string, g: Group) {
    const select = (tolerance: number, maxBody: number) => g.rows.filter((r) => r.gap <= tolerance && r.body <= maxBody && r.x > 0);
    const main = select(128, 512);
    const byEnd = new Map(g.rows.filter((r) => r.gap <= 128).map((r) => [r.nextId, r]));
    const lagged = main.flatMap((r) => {
        const prior = byEnd.get(r.id);
        return prior && prior.x > 0 ? [{ ...r, previous: prior.x }] : [];
    });
    const mainFit = fit(main);
    const zero = g.rows.filter((r) => r.gap <= 128 && r.body <= 512 && r.x === 0 && r.reasoningLocal === 0);
    const examples = [...main].sort((a, b) => a.x - b.x);
    const indices = exampleIndices(examples.length);
    return {
        key, steps: g.steps, reportedReasoningSteps: g.reportedReasoningSteps,
        candidates: g.candidates, exclusions: g.exclusions,
        cacheEligible512: g.rows.length, cacheEligible128: g.rows.filter((r) => r.gap <= 128).length,
        selected: main.length, basis: [...new Set(main.map((r) => r.basis))],
        outputConvention: key.startsWith("oc1|") ? "visible-only-when-reasoning-reported; otherwise-text-fallback" : "includes-reasoning",
        calibration: resolveModelCalibration(key.split("|")[1].split("/")[0], key.split("|")[1].split("/").slice(1).join("/")),
        main: mainFit, lag: fitLag(lagged),
        literalBriefFormula: fit(main.filter((r) => r.basis === "reported").map((r) => ({ ...r, y: r.y + (key.startsWith("oc1|") ? r.x : 0) }))),
        smallBody128: fit(select(128, 128)), widerBody2048: fit(select(128, 2048)),
        exactPrefix: fit(select(0, 512)), loosePrefix512: fit(select(512, 512)),
        noTool: fit(main.filter((r) => r.tools === 0)), newUser: fit(main.filter((r) => r.users > 0)),
        noUser: fit(main.filter((r) => r.users === 0)),
        textCrossCheck: fit(main.filter((r) => r.reasoningLocal > 0).map((r) => ({ ...r, x: r.reasoningLocal }))),
        zeroReasoningControl: {
            n: zero.length,
            residualQ10Q50Q90: [0.1, 0.5, 0.9].map((p) => quantile(zero.map((r) => r.y), p)),
            residualOverBodyQ10Q50Q90: [0.1, 0.5, 0.9].map((p) => quantile(zero.filter((r) => r.body >= 64).map((r) => r.y / r.body), p)),
        },
        examples: indices.filter((i) => i >= 0).map((i) => examples[i]),
    };
}

async function main() {
    const args = process.argv.slice(2);
    const rootArg = args[0];
    if (!rootArg) throw new Error("Usage: timeout 1800s bun analyze.ts SCRATCH_ROOT [SINCE_ISO UNTIL_ISO]");
    const root = realpathSync(resolve(rootArg));
    // Keep all scratch output within the prescribed root. Source OpenCode stores
    // are opened read-only and SELECTed narrowly, never copied in their entirety.
    const allowed = realpathSync(resolve(process.env.TMPDIR ?? "/tmp", "magic-context/reasoning-diff"));
    if (root !== allowed) throw new Error("Only the reasoning-diff scratch root is accepted");
    if (args[1]) since = Date.parse(args[1]);
    if (args[2]) until = Date.parse(args[2]);
    if (!Number.isFinite(since) || !Number.isFinite(until) || since > until) throw new Error("Invalid date window");
    if (!await preloadTokenizer()) throw new Error("MC tokenizer unavailable; refusing heuristic measurements");
    const source = join(homedir(), ".local/share/opencode");
    const filenames = readdirSync(source).filter((name) => /^opencode.*\.db$/.test(name));
    if (!filenames.length) throw new Error("No named OpenCode stores found");
    for (const filename of filenames) {
        const path = join(source, filename);
        const db = new Database(path, { readonly: true });
        try {
            db.exec("BEGIN");
            const tables = db.query("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>;
            if (tables.some((t) => t.name === "message") && tables.some((t) => t.name === "part")) oc1(db);
            else if (tables.some((t) => t.name === "session_message")) oc2(db);
            else throw new Error(`Unsupported store schema: ${filename}`);
        } finally { db.exec("ROLLBACK"); db.close(); }
        console.log(`Read ${filename}: ${groups.size} route groups`);
    }
    for (const directory of readdirSync(join(root, "pi"))) {
        for (const filename of readdirSync(join(root, "pi", directory))) {
            if (!filename.endsWith(".jsonl")) continue;
            const path = realpathSync(join(root, "pi", directory, filename));
            if (!path.startsWith(`${root}${sep}`)) throw new Error("Pi symlink escapes temporary root");
            await pi(path);
            console.log(`Read Pi copy ${filename}`);
        }
    }
    if (!getTokenEstimatorFingerprint().startsWith("tokenizer:")) throw new Error("Tokenizer fell back during measurement");
    const results = {
        measuredAt: new Date().toISOString(),
        since: new Date(since).toISOString(), until: new Date(until).toISOString(),
        tokenizer: getTokenEstimatorFingerprint(), calibrationRevision: CALIBRATION_TABLE_REVISION,
        inventory, groups: [...groups].map(([k, g]) => summarize(k, g)).sort((a, b) => b.steps - a.steps),
    };
    writeFileSync(join(root, "summary.json"), JSON.stringify(results, null, 2));
    // All numeric rows are retained in the temporary root for independent analysis.
    writeFileSync(join(root, "pairs.jsonl"), [...groups].flatMap(([key, g]) => g.rows.map((r) => JSON.stringify({ key, ...r }))).join("\n"));
    console.log(`Measured ${results.groups.length} groups; ${results.groups.reduce((a, b) => a + b.selected, 0)} small-content pairs. Numeric-only summary.json and pairs.jsonl written.`);
}
if (import.meta.main) await main();
