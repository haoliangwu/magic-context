/** Offline replay of APFS snapshots; never point this script at live stores. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { MessageLike } from "../src/hooks/magic-context/tag-messages";

const snapshot = realpathSync(process.argv[2]);
const scratch = join(realpathSync(dirname(resolve(process.argv[3]))), process.argv[3].split("/").at(-1)!);
const sessionId = process.argv[4];
const source = resolve(process.env.PERF_SOURCE_ROOT ?? join(import.meta.dir, "../../.."));
const safeRoot = realpathSync(join(tmpdir(), "magic-context/perf-ts"));
assert(snapshot.startsWith(`${safeRoot}/`) && scratch.startsWith(`${safeRoot}/`));
assert(!existsSync(scratch), "use a fresh replay directory");
mkdirSync(join(scratch, "context"), { recursive: true });
mkdirSync(join(scratch, "opencode"), { recursive: true });
for (const [directory, base] of [["context", "context.db"], ["opencode", "opencode.db"]]) {
    for (const suffix of ["", "-wal", "-shm"]) {
        const from = join(snapshot, directory, base + suffix);
        if (existsSync(from)) execFileSync("cp", ["-c", from, join(scratch, directory, base + suffix)]);
    }
}
process.env.OPENCODE_DB = join(scratch, "opencode/opencode.db");
process.env.MAGIC_CONTEXT_STORAGE_DIR = join(scratch, "context");
process.env.XDG_DATA_HOME = scratch;
process.env.XDG_CACHE_HOME = scratch;
process.env.MAGIC_CONTEXT_LOG_PATH = join(scratch, "replay.log");
const load = (path: string) => import(join(source, "packages/plugin/src", path));
console.error("loading transform modules");
const { Database } = await load("shared/sqlite.ts");
const { createTransform } = await load("hooks/magic-context/transform.ts");
const { createTagger } = await load("features/magic-context/tagger.ts");
const db = new Database(join(scratch, "context/context.db"));
const host = new Database(process.env.OPENCODE_DB, { readonly: true });
console.error("reading cloned messages");
const markerRow = db.prepare("SELECT compaction_marker_state FROM session_meta WHERE session_id=?").get(sessionId);
const marker = markerRow?.compaction_marker_state ? JSON.parse(markerRow.compaction_marker_state) : null;
let since = 0;
if (marker) {
    const summary = host.prepare("SELECT data FROM message WHERE id=?").get(marker.summaryMessageId);
    const info = summary ? JSON.parse(summary.data) : null;
    if (info?.summary && info.finish && !info.error && info.parentID === marker.boundaryMessageId) {
        since = host.prepare("SELECT time_created FROM message WHERE id=?").get(marker.boundaryMessageId)?.time_created ?? 0;
    }
}
const rows = host.prepare("SELECT id,data,time_created FROM message WHERE session_id=? AND time_created>=? ORDER BY time_created,id").all(sessionId, since);
console.error(`reading cloned parts for ${rows.length} messages`);
const partRows = rows.flatMap((row: {id: string}) => host.prepare("SELECT id,message_id,data FROM part WHERE message_id=? ORDER BY id").all(row.id));
const parts = new Map<string, unknown[]>();
for (const row of partRows) {
    const list = parts.get(row.message_id) ?? [];
    list.push({ ...JSON.parse(row.data), id: row.id, messageID: row.message_id, sessionID: sessionId });
    parts.set(row.message_id, list);
}
const all: MessageLike[] = rows.map((row: {id: string; data: string}) => ({
    info: { ...JSON.parse(row.data), id: row.id, sessionID: sessionId },
    parts: parts.get(row.id) ?? [],
}));
// Retain history starting at the newest user compaction message that has a
// completed assistant summary. An unfinished summary cannot remove earlier history.
const completed = new Set<string>();
let start = 0;
for (let i = all.length - 1; i >= 0; i--) {
    const info = all[i].info as Record<string, unknown>;
    if (info.role === "assistant" && info.summary && info.finish && !info.error && typeof info.parentID === "string") completed.add(info.parentID);
    if (info.role === "user" && typeof info.id === "string" && completed.has(info.id) && all[i].parts.some((part) => (part as {type?: string}).type === "compaction")) {
        start = i;
        break;
    }
}
const messages = all.slice(start);
const model = [...messages].reverse().map((m) => m.info as Record<string, unknown>).find((info) => info.role === "assistant" && typeof info.modelID === "string");
const tagger = createTagger();
const transform = createTransform({
    db, tagger, scheduler: { shouldExecute: () => "defer" }, contextUsageMap: new Map(),
    historyRefreshSessions: new Set(), pendingMaterializationSessions: new Set(), lastHeuristicsTurnId: new Map(),
    clearReasoningAge: 6, protectedTokens: 6000, commitClusterTrigger: { enabled: true, min_clusters: 3 },
    liveModelBySession: new Map([[sessionId, { providerID: String(model?.providerID ?? "anthropic"), modelID: String(model?.modelID ?? "claude-fable-5") }]]),
    // No host client or completion executor: run local decisions and reads without
    // sending a summarization request to a model provider.
});
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
console.error(`replaying ${messages.length} visible messages`);
if (process.env.PERF_TRIGGER_ONLY === "1") {
    const { checkCompartmentTrigger, buildTriggerInMemoryTail } = await load("hooks/magic-context/compartment-trigger.ts");
    const { getOrCreateSessionMeta } = await load("features/magic-context/storage.ts");
    const meta = getOrCreateSessionMeta(db, sessionId);
    meta.compartmentInProgress = false;
    for (let pass = 0; pass < 2; pass++) {
        const tail = buildTriggerInMemoryTail(db, sessionId, messages);
        const start = performance.now();
        const result = checkCompartmentTrigger(db, sessionId, meta,
            { percentage: meta.lastContextPercentage, inputTokens: meta.lastInputTokens },
            meta.lastContextPercentage, 65, 32000, 6, {enabled: true, min_clusters: 3},
            undefined, 200000, tail);
        console.log(JSON.stringify({ pass, wallMs: performance.now() - start, inMemoryTail: tail !== undefined,
            shouldFire: result.shouldFire, reason: result.reason, boundary: result.boundarySnapshot?.lastCompartmentEndMessageId }));
    }
    db.close(); host.close(); process.exit(0);
}
if (process.env.PERF_INJECTION_ONLY === "1") {
    const { prepareCompartmentInjection } = await load("hooks/magic-context/inject-compartments.ts");
    for (let pass = 0; pass < 3; pass++) {
        const wire = structuredClone(messages);
        const start = performance.now();
        const prepared = prepareCompartmentInjection(db, sessionId, wire, false);
        console.log(JSON.stringify({ pass, wallMs: performance.now() - start, rebuilt: prepared?.rebuiltFromDb,
            boundary: prepared?.compartmentEndMessageId, blockSha256: hash(prepared?.block), wireSha256: hash(wire) }));
    }
    db.close(); host.close();
    process.exit(0);
}
const results = [];
for (let pass = 0; pass < Number(process.env.PERF_PASSES ?? 8); pass++) {
    const input = process.env.PERF_ADVANCE === "1"
        ? [...messages, ...Array.from({ length: pass }, (_, index) => ({
            info: { id: `perf-new-${index}`, role: "user", sessionID: sessionId },
            parts: [{ type: "text", text: `Continue verification ${index}.` }],
        }))]
        : messages;
    const output = { messages: structuredClone(input) };
    const start = performance.now();
    await transform({}, output);
    const wallMs = performance.now() - start;
    results.push({ pass, wallMs, messages: output.messages.length, sha256: hash(output.messages) });
}
console.log(JSON.stringify({ sessionId, inputMessages: messages.length, results }));
console.log(execFileSync("lsof", ["-nP", "-p", String(process.pid)], { encoding: "utf8" }).split("\n").filter((line) => /context\.db|opencode\.db/.test(line)).join("\n"));
await Bun.sleep(600);
const stages: Record<string, number[]> = {};
for (const line of readFileSync(join(scratch, "replay.log"), "utf8").split("\n")) {
    const match = /transform stage: stage=(\S+) elapsed=([\d.]+)ms/.exec(line);
    if (match) (stages[match[1]] ??= []).push(Number(match[2]));
}
const summarize = (values: number[]) => {
    const sorted = values.slice(1).sort((a,b) => a-b);
    return { n: sorted.length, p50: sorted[Math.floor(sorted.length / 2)], p99: sorted.at(-1) };
};
console.log(JSON.stringify({ wall: summarize(results.map((r) => r.wallMs)), stages: Object.fromEntries(Object.entries(stages).map(([name, values]) => [name, summarize(values)])) }));
db.close();
host.close();
process.exit(0);
