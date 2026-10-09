/**
 * Replay one OpenCode execute pass of a cloned session and report its stage timers.
 *
 * Offline only: the snapshot directory holds `context/context.db` (a
 * `VACUUM INTO` copy of the live store) and `opencode/opencode.db` (a copy of
 * the session's rows). Every run clones the snapshot into a fresh scratch
 * directory, so the snapshot itself is never written. Both directories must sit
 * under `$TMPDIR/magic-context/`, and the throwaway roots (XDG dirs, HOME,
 * CFFIXED_USER_HOME, OPENCODE_DB, MAGIC_CONTEXT_STORAGE_DIR) must already point
 * inside the scratch directory when the process starts; the script refuses to
 * run otherwise and prints `lsof` lines for the open database files at the end.
 *
 *   bun packages/plugin/scripts/replay-execute-pass.ts <snapshot> <scratch> <sessionId>
 *
 * Optional environment:
 *   REPLAY_SOURCE_ROOT        source tree to load (default: this checkout), so a
 *                             base-commit export can run the same input
 *   REPLAY_MESSAGES           keep only the newest N visible messages
 *   REPLAY_IGNORE_MARKER=1    take messages from before the compaction boundary too
 *   REPLAY_MATERIALIZATION    "none" skips the deferred-materialization signal
 *   REPLAY_DEFERRED_HISTORY=1 consume published history, draining a pending marker
 *   REPLAY_PENDING_OPS        queue N drop ops on the oldest visible active tags
 *   REPLAY_HOST_DELAY_MS      delay for every OpenCode API call of the fake host
 *   REPLAY_USAGE_PERCENT      context usage the pass sees (default 75.1)
 *
 * The fake host answers `app.agents` and `session.get` with an empty permission
 * set after REPLAY_HOST_DELAY_MS, and every other API call with no data. The
 * historian is disabled so no summarization request leaves the process and the
 * served array is deterministic for a differential between two source trees.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { MessageLike } from "../src/hooks/magic-context/tag-messages";

const [snapshotArg, scratchArg, sessionId] = process.argv.slice(2);
assert(snapshotArg && scratchArg && sessionId, "usage: <snapshot> <scratch> <sessionId>");
const safeRoot = realpathSync(join(tmpdir(), "magic-context"));
const snapshot = realpathSync(snapshotArg);
const scratchLexical = resolve(scratchArg);
assert(
    !existsSync(join(scratchLexical, "context")) && !existsSync(join(scratchLexical, "opencode")),
    "use a fresh scratch directory",
);
mkdirSync(scratchLexical, { recursive: true });
const scratch = realpathSync(scratchLexical);
assert(snapshot.startsWith(`${safeRoot}/`), `snapshot must be under ${safeRoot}`);
assert(scratch.startsWith(`${safeRoot}/`), `scratch must be under ${safeRoot}`);
const insideScratch = (value: string | undefined): boolean =>
    value !== undefined &&
    (resolve(value).startsWith(`${scratchLexical}/`) || resolve(value).startsWith(`${scratch}/`));
for (const name of [
    "HOME",
    "CFFIXED_USER_HOME",
    "XDG_DATA_HOME",
    "XDG_CACHE_HOME",
    "XDG_CONFIG_HOME",
    "XDG_STATE_HOME",
    "OPENCODE_DB",
    "MAGIC_CONTEXT_STORAGE_DIR",
    "MAGIC_CONTEXT_LOG_PATH",
]) {
    const value = process.env[name];
    assert(insideScratch(value), `${name} must point inside ${scratch}`);
}
mkdirSync(join(scratch, "context"), { recursive: true });
mkdirSync(join(scratch, "opencode"), { recursive: true });
for (const [directory, base] of [
    ["context", "context.db"],
    ["opencode", "opencode.db"],
] as const) {
    for (const suffix of ["", "-wal", "-shm"]) {
        const from = join(snapshot, directory, base + suffix);
        if (existsSync(from)) execFileSync("cp", ["-c", from, join(scratch, directory, base + suffix)]);
    }
}
assert(insideScratch(process.env.OPENCODE_DB) && process.env.OPENCODE_DB?.endsWith("/opencode/opencode.db"));
assert(insideScratch(`${process.env.MAGIC_CONTEXT_STORAGE_DIR}/`));

const source = resolve(process.env.REPLAY_SOURCE_ROOT ?? join(import.meta.dir, "../../.."));
const load = (path: string) => import(join(source, "packages/plugin/src", path));
const { Database } = await load("shared/sqlite.ts");
const { createTransform } = await load("hooks/magic-context/transform.ts");
const { createTagger } = await load("features/magic-context/tagger.ts");
const { getActiveTagsBySession, queuePendingOp } = await load("features/magic-context/storage.ts");
const { resolveProjectIdentity } = await load("features/magic-context/memory/project-identity.ts");
const { flushLogger } = await load("shared/logger.ts");

const db = new Database(join(scratch, "context/context.db"));
const host = new Database(join(scratch, "opencode/opencode.db"), { readonly: true });

// Rebuild the array OpenCode 1 hands the transform: history from the newest
// compaction boundary that has a completed summary.
type Row = { id: string; data: string; time_created: number };
const rows = host
    .prepare("SELECT id, data, time_created FROM message WHERE session_id = ? ORDER BY time_created, id")
    .all(sessionId) as Row[];
const parts = new Map<string, unknown[]>();
for (const row of host
    .prepare("SELECT id, message_id, data FROM part WHERE session_id = ? ORDER BY message_id, id")
    .all(sessionId) as Array<{ id: string; message_id: string; data: string }>) {
    const list = parts.get(row.message_id) ?? [];
    list.push({ ...JSON.parse(row.data), id: row.id, messageID: row.message_id, sessionID: sessionId });
    parts.set(row.message_id, list);
}
const all: MessageLike[] = rows.map((row) => ({
    info: { ...JSON.parse(row.data), id: row.id, sessionID: sessionId },
    parts: parts.get(row.id) ?? [],
}));
const completed = new Set<string>();
let start = 0;
for (let index = all.length - 1; index >= 0; index -= 1) {
    const info = all[index].info as Record<string, unknown>;
    if (info.role === "assistant" && info.summary && info.finish && !info.error && typeof info.parentID === "string") {
        completed.add(info.parentID);
    }
    if (
        info.role === "user" &&
        typeof info.id === "string" &&
        completed.has(info.id) &&
        all[index].parts.some((part) => (part as { type?: string }).type === "compaction")
    ) {
        start = index;
        break;
    }
}
// REPLAY_IGNORE_MARKER=1 keeps rows before the boundary too, for a wire as long
// as one the host served before its marker last moved.
let messages = process.env.REPLAY_IGNORE_MARKER === "1" ? all : all.slice(start);
const keep = Number(process.env.REPLAY_MESSAGES ?? 0);
if (keep > 0 && messages.length > keep) messages = messages.slice(-keep);
const sessionRow = host.prepare("SELECT directory FROM session WHERE id = ?").get(sessionId) as
    | { directory: string }
    | undefined;
const directory = sessionRow?.directory ?? process.cwd();
const model = [...messages]
    .reverse()
    .map((message) => message.info as Record<string, unknown>)
    .find((info) => info.role === "assistant" && typeof info.modelID === "string");

const hostDelayMs = Number(process.env.REPLAY_HOST_DELAY_MS ?? 0);
const hostCalls: string[] = [];
const respond = (path: string, data: unknown) => {
    hostCalls.push(path);
    return new Promise((resolveCall) => setTimeout(() => resolveCall({ data }), hostDelayMs));
};
const client = {
    app: { agents: () => respond("app.agents", [{ name: "build", permission: [] }]) },
    session: new Proxy(
        { get: () => respond("session.get", { id: sessionId, directory, agent: "build", permission: [] }) },
        {
            get: (target, key: string) =>
                key in target ? target[key as "get"] : () => respond(`session.${key}`, undefined),
        },
    ),
    tui: new Proxy({}, { get: (_target, key: string) => () => respond(`tui.${key}`, undefined) }),
};

// Settings from the affected session's host: execute at 75%, mural on, caveman
// at 250 characters, smart drops and temporal awareness on, reasoning age 30.
const usagePercent = Number(process.env.REPLAY_USAGE_PERCENT ?? 75.1);
const inputTokens = Math.round((usagePercent / 100) * 871_600);
const modelKey = `${String(model?.providerID ?? "anthropic")}/${String(model?.modelID ?? "claude-opus-5-5")}`;
let decision: "defer" | "execute" = "defer";
const contextUsageMap = new Map();
const deferredMaterializationSessions = new Set<string>();
const deferredHistoryRefreshSessions = new Set<string>();
const transform = createTransform({
    db,
    tagger: createTagger(),
    storeGeneration: "v1",
    scheduler: { shouldExecute: () => decision },
    contextUsageMap,
    historyRefreshSessions: new Set(),
    deferredHistoryRefreshSessions,
    pendingMaterializationSessions: new Set(),
    deferredMaterializationSessions,
    lastHeuristicsTurnId: new Map(),
    clearReasoningAge: 30,
    commitClusterTrigger: { enabled: true, min_clusters: 3 },
    executeThresholdPercentage: { default: 75 },
    client: client as never,
    directory,
    projectPath: resolveProjectIdentity(directory),
    memoryConfig: { enabled: true, injectionBudgetTokens: 15000, autoPromote: true },
    historyBudgetPercentage: 0.15,
    historianRunnable: false,
    muralEnabled: true,
    smartDrops: true,
    experimentalTemporalAwareness: true,
    cavemanTextCompression: { enabled: true, minChars: 250 },
    autoSearch: { enabled: false, scoreThreshold: 0.6, minPromptChars: 20, directory },
    getModelKey: () => modelKey,
    getFallbackModelId: () => modelKey,
    liveModelBySession: new Map([
        [
            sessionId,
            {
                providerID: modelKey.split("/")[0],
                modelID: modelKey.split("/").slice(1).join("/"),
            },
        ],
    ]),
});

// A process's first pass resets persisted usage, so warm the process with one
// defer pass, as the long-lived host was, before the measured execute pass.
console.error(`warming with a defer pass over ${messages.length} visible messages`);
await transform({}, { messages: structuredClone(messages) });
const logPath = process.env.MAGIC_CONTEXT_LOG_PATH ?? "";
flushLogger();
const warmLogBytes = existsSync(logPath) ? readFileSync(logPath, "utf8").length : 0;
hostCalls.length = 0;

// Queue drop ops on the oldest active tags whose owner is on this wire, as an
// agent's ctx_reduce backlog would. Tags in the newest 200 visible messages stay
// untouched so the queue never targets the protected tail.
const pendingOps = Number(process.env.REPLAY_PENDING_OPS ?? 0);
if (pendingOps > 0) {
    const visible = new Set(messages.slice(0, -200).map((message) => String(message.info.id)));
    const candidates = (getActiveTagsBySession(db, sessionId) as Array<{
        tagNumber: number;
        messageId: string;
        toolOwnerMessageId?: string | null;
    }>)
        .filter((tag) => visible.has(tag.toolOwnerMessageId ?? "") || visible.has(String(tag.messageId).split(":")[0]))
        .sort((left, right) => left.tagNumber - right.tagNumber)
        .slice(0, pendingOps);
    for (const [index, tag] of candidates.entries()) {
        queuePendingOp(db, sessionId, tag.tagNumber, "drop", 1_791_367_000_000 + index);
    }
    console.error(`queued ${candidates.length} pending drop ops`);
}


decision = "execute";
contextUsageMap.set(sessionId, {
    usage: { percentage: usagePercent, inputTokens },
    updatedAt: Date.now(),
    lastResponseTime: Date.now() - 60_000,
    hasUsageTokens: true,
});
if (process.env.REPLAY_MATERIALIZATION !== "none") deferredMaterializationSessions.add(sessionId);
// Published history the pass consumes, which drains a pending compaction marker.
if (process.env.REPLAY_DEFERRED_HISTORY === "1") deferredHistoryRefreshSessions.add(sessionId);
console.error(`replaying execute pass over ${messages.length} visible messages`);
const output = { messages: structuredClone(messages) };
const startedAt = performance.now();
await transform({}, output);
const wallMs = performance.now() - startedAt;
const sha256 = createHash("sha256").update(JSON.stringify(output.messages)).digest("hex");
const lsof = execFileSync("lsof", ["-nP", "-p", String(process.pid)], { encoding: "utf8" })
    .split("\n")
    .filter((line) => /\.db\b/.test(line));
flushLogger();
const stages: Array<[string, number]> = [];
for (const line of readFileSync(logPath, "utf8").slice(warmLogBytes).split("\n")) {
    if (!line.includes(sessionId)) continue;
    const match = /transform stage: stage=(\S+) elapsed=([\d.]+)ms/.exec(line);
    if (match) stages.push([match[1], Number(match[2])]);
}
console.log(
    JSON.stringify(
        {
            sessionId,
            source,
            inputMessages: messages.length,
            outputMessages: output.messages.length,
            sha256,
            wallMs: Number(wallMs.toFixed(1)),
            hostDelayMs,
            hostCalls,
            stages,
            lsof,
        },
        null,
        1,
    ),
);
db.close();
host.close();
process.exit(0);
