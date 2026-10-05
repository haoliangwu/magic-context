#!/usr/bin/env bun
// Compare the real transform and persisted replay using isolated stores.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { TransformDeps } from "../../src/hooks/magic-context/transform";
import type { MessageLike } from "../../src/hooks/magic-context/tag-messages";

const root = mkdtempSync(join(process.cwd(), ".tx-replay-"));
for (const key of ["HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_CONFIG_HOME", "MAGIC_CONTEXT_DATA_DIR"]) process.env[key] = root;
process.env.MAGIC_CONTEXT_LOG_PATH = join(root, "plugin.log");
const baselineRef = Bun.argv.find(arg => arg.startsWith("--base="))?.slice(7) ?? "ee9d82912cd8105322672a1f5dd1bbb7172a2f46";
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const importFrom = async (prefix: string, file: string) => import(pathToFileURL(join(prefix, "packages/plugin/src", file)).href);
type Runtime = { transform: typeof import("../../src/hooks/magic-context/transform"), sqlite: typeof import("../../src/shared/sqlite"), storage: typeof import("../../src/features/magic-context/storage-db"), meta: typeof import("../../src/features/magic-context/storage-meta-session"), tagger: typeof import("../../src/features/magic-context/tagger"), tags: typeof import("../../src/features/magic-context/storage-tags") };
async function runtime(prefix: string): Promise<Runtime> {
    return {
        transform: await importFrom(prefix, "hooks/magic-context/transform.ts"),
        sqlite: await importFrom(prefix, "shared/sqlite.ts"),
        storage: await importFrom(prefix, "features/magic-context/storage-db.ts"),
        meta: await importFrom(prefix, "features/magic-context/storage-meta-session.ts"),
        tagger: await importFrom(prefix, "features/magic-context/tagger.ts"),
        tags: await importFrom(prefix, "features/magic-context/storage-tags.ts"),
    };
}
function compareDroppedReads(before: Runtime, after: Runtime, size: number) {
    const real = new after.sqlite.Database(":memory:");
    after.storage.initializeDatabase(real);
    after.meta.getOrCreateSessionMeta(real, "dropped");
    const insert = real.prepare("INSERT INTO tags (session_id, tag_number, message_id, type, status, byte_size, token_count, harness) VALUES ('dropped', ?, ?, 'message', ?, 1, 1, 'opencode')");
    real.transaction(() => {
        for (let i = 1; i <= size; i++) insert.run(i, `m-${i}:p0`, i % 50 === 0 ? "dropped" : "active");
    })();
    const numbers = Array.from({ length: size }, (_, i) => i + 1);
    try {
        let expected = "";
        for (const [label, api] of [["before", before], ["after", after]] as const) {
            let compiles = 0;
            const db = new Proxy(real, {
                get(target, key) {
                    if (key === "prepare") return (sql: string) => { compiles++; return target.prepare(sql); };
                    const value = Reflect.get(target, key);
                    return typeof value === "function" ? value.bind(target) : value;
                },
            });
            const hashes: string[] = [];
            const samples: number[] = [];
            for (let sample = 0; sample < 4; sample++) {
                const start = performance.now();
                const result = api.tags.getDroppedTagsByNumbers(db, "dropped", numbers);
                samples.push(performance.now() - start);
                hashes.push(hash(result));
            }
            if (label === "before") expected = hashes[0];
            if (hashes.some(value => value !== expected)) throw new Error("dropped read rows changed");
            console.log(JSON.stringify({ finding: "TX-14 paired 98%-active replay", label, messages: size, medianMs: +samples.slice(1).sort((a, b) => a - b)[1].toFixed(3), compilesAcrossFourPasses: compiles }));
        }
    } finally { real.close(); }
}
async function replay(api: Runtime, messages: MessageLike[], label: string) {
    const db = new api.sqlite.Database(":memory:");
    api.storage.initializeDatabase(db);
    const sid = "tx-replay";
    api.meta.getOrCreateSessionMeta(db, sid);
    const insert = db.prepare("INSERT INTO tags (session_id, tag_number, message_id, type, status, byte_size, token_count, harness) VALUES (?, ?, ?, 'message', 'active', 600, 110, 'opencode')");
    const source = db.prepare("INSERT INTO source_contents (session_id, tag_id, content, created_at, harness) VALUES (?, ?, ?, 0, 'opencode')");
    db.transaction(() => messages.forEach((message, i) => {
        insert.run(sid, i + 1, `${message.info.id}:p0`);
        source.run(sid, i + 1, (message.parts[0] as { text: string }).text);
    }))();
    const deps: TransformDeps = {
        db, tagger: api.tagger.createTagger(), scheduler: { shouldExecute: () => "defer" }, contextUsageMap: new Map(),
        historyRefreshSessions: new Set(), pendingMaterializationSessions: new Set(), lastHeuristicsTurnId: new Map(),
        clearReasoningAge: 100_000, protectedTokens: 0, historianRunnable: false, injectDocs: false,
        memoryConfig: { enabled: false, injectionBudgetTokens: 0, autoPromote: false }, channel1StateBySession: new Map(),
    };
    const transform = api.transform.createTransform(deps);
    const hashes: string[] = [];
    const times: number[] = [];
    try {
        // First render is a HARD initialization; subsequent appends are DEFER.
        for (let turn = 0; turn < 4; turn++) {
            const output = { messages: structuredClone(messages) };
            if (turn > 0) output.messages.push({ info: { id: `tail-${turn}`, role: "user", sessionID: sid }, parts: [{ type: "text", text: `New tail ${turn}` }] });
            const started = performance.now();
            await transform({}, output);
            times.push(performance.now() - started);
            hashes.push(hash(output.messages));
            if (!deps.channel1StateBySession?.get(sid)?.evaluable) throw new Error("hygiene measurement was not reached");
        }
        const decisions = db.prepare("SELECT tag_number, message_id, type, status, drop_mode, caveman_depth, token_count FROM tags ORDER BY tag_number").all();
        const baseline = deps.channel1StateBySession?.get(sid);
        console.log(JSON.stringify({ label, messages: messages.length, deferMedianMs: +times.slice(1).sort((a, b) => a - b)[1].toFixed(3), hashes, decisionHash: hash(decisions), effective: baseline && [baseline.baselineU + baseline.turnDeltaU, baseline.baselineT + baseline.turnDeltaT] }));
        const effective = baseline && [baseline.baselineU + baseline.turnDeltaU, baseline.baselineT + baseline.turnDeltaT];
        const persistedReplay = db.prepare("SELECT cached_m0_bytes, cached_m1_bytes, stale_reduce_stripped_ids, processed_image_stripped_ids, stripped_placeholder_ids, merged_reasoning_stripped_ids, trailing_blank_decisions FROM session_meta WHERE session_id = ?").get(sid);
        return { hashes, decisionHash: hash(decisions), effective, replayHash: hash(persistedReplay) };
    } finally { db.close(); }
}
try {
    const archive = execFileSync("git", ["archive", baselineRef, "packages/plugin"], { maxBuffer: 128 * 1024 * 1024 });
    execFileSync("tar", ["-x", "-C", root], { input: archive });
    symlinkSync(resolve("packages/plugin/node_modules"), join(root, "packages/plugin/node_modules"), "dir");
    if (Bun.argv.includes("--stages-only")) {
        const relative = "packages/plugin/scripts/perf-audit/tx.ts";
        mkdirSync(join(root, "packages/plugin/scripts/perf-audit"), { recursive: true });
        copyFileSync(resolve(relative), join(root, relative));
        const filters = Bun.argv.filter(arg => arg.startsWith("--only="));
        for (const [label, path, args] of [["before", join(root, relative), filters], ["after", resolve(relative), ["--after", ...filters]]] as const) {
            console.log(`STAGES ${label}: ${label === "before" ? baselineRef : "working tree"}`);
            console.log(execFileSync(process.execPath, [path, ...args], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 }));
        }
    } else {
    const before = await runtime(root);
    const after = await runtime(resolve("."));
    for (const size of [1000, 10000, 60000]) {
        if (Bun.argv.includes("--reads-only")) {
            compareDroppedReads(before, after, size);
            continue;
        }
        const messages: MessageLike[] = Array.from({ length: size }, (_, i) => ({ info: { id: `msg-${i}`, role: i % 2 ? "assistant" : "user", sessionID: "tx-replay" }, parts: [{ type: "text", text: `Request ${i}: ` + "Inspect the source and preserve the cached prefix. ".repeat(12) }] }));
        const old = await replay(before, messages, "before");
        const next = await replay(after, messages, "after");
        if (JSON.stringify(old) !== JSON.stringify(next)) throw new Error(`wire or persisted decisions changed at ${size}`);
    }
    console.log(Bun.argv.includes("--reads-only")
        ? `Bun ${Bun.version}: 12 before/after dropped-read arrays byte-identical`
        : `Bun ${Bun.version}: 12 before/after transform wires and 3 persisted tag decisions byte-identical`);
    }
} finally { rmSync(root, { recursive: true, force: true }); }
