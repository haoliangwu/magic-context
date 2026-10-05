/// <reference types="bun-types" />

/**
 * Single-store rehearsal, live host step: drive a real OpenCode host (whatever
 * `opencode` is on PATH; the rehearsal pins 1.18.30) against a clone of a store that
 * `migrate-drill.sh` already migrated, with the mock provider only.
 *
 *   bun scripts/b2-drill/host-drill.ts drive   <host-root>
 *   bun scripts/b2-drill/host-drill.ts refusal <host-root>
 *
 * <host-root> must be a throwaway directory under $TMPDIR/magic-context/ holding
 * data/cortexkit/magic-context/{context,store}.db and data/opencode/opencode.db. It is
 * deleted by the harness when the drill ends.
 *
 * drive: Rust first render, ctx_memory write/update/archive, a note, ctx_search
 *   finding it, a historian fold landing in context.db, ctx_expand over the folded
 *   range, host and module restarts, and a Rust -> TS -> Rust switch.
 * refusal: the same host in Rust mode on an UNMIGRATED store must surface MC-C14 in
 *   the session, while TS mode on the same store still serves a turn.
 *
 * After every phase the open files of the host, module, daemon and producer are
 * listed with lsof, and the drill fails if any database path lies outside the root.
 * Set MC_E2E_CK_MC_PREBUILT_BIN / MC_E2E_CK_SUBC_BIN to reuse built binaries.
 */

import { Database } from "bun:sqlite";
import { spawnSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { RustTestHarness } from "../../packages/e2e-tests/src/rust-harness";

const [mode, rootArg] = process.argv.slice(2);
if ((mode !== "drive" && mode !== "refusal") || !rootArg) {
    console.error("usage: host-drill.ts drive|refusal <host-root>");
    process.exit(2);
}
const root = realpathSync(rootArg);
if (!root.startsWith(`${realpathSync(tmpdir())}/magic-context/`)) {
    console.error(`refusing host root outside $TMPDIR/magic-context: ${root}`);
    process.exit(2);
}
const env = {
    configDir: join(root, "config"),
    dataDir: join(root, "data"),
    cacheDir: join(root, "cache"),
    workdir: join(root, "work"),
};
const storeDir = join(env.dataDir, "cortexkit", "magic-context");
for (const file of [
    join(storeDir, "context.db"),
    join(storeDir, "store.db"),
    join(env.dataDir, "opencode", "opencode.db"),
]) {
    if (!existsSync(file)) throw new Error(`missing copied database ${file}`);
}

// A copied store keeps the live writer's lease epoch; a fresh isolated lease starts at
// one. Reset only that lease row so the throwaway module can claim the copy.
for (const name of ["context.db", "store.db"]) {
    const db = new Database(join(storeDir, name));
    try {
        const hasFence = db
            .query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'cortexkit_fence'")
            .get();
        if (hasFence) db.run("UPDATE cortexkit_fence SET epoch = 0 WHERE id = 0");
    } finally {
        db.close();
    }
}

const log = (event: string, detail: Record<string, unknown> = {}) =>
    console.log(JSON.stringify({ at: new Date().toISOString(), event, ...detail }));

function auditOpenFiles(phase: string, hostPid: number): void {
    const pids = new Set<number>([hostPid]);
    const found = spawnSync("pgrep", ["-f", root], { encoding: "utf8" });
    for (const line of found.stdout.split("\n")) if (Number(line) > 0) pids.add(Number(line));
    const databases: string[] = [];
    for (const pid of pids) {
        const out = spawnSync("lsof", ["-p", String(pid), "-Fn"], { encoding: "utf8" });
        if (out.status !== 0 && pid === hostPid) throw new Error(`lsof failed for host ${pid}`);
        for (const line of out.stdout.split("\n")) {
            if (!line.startsWith("n")) continue;
            const path = line.slice(1);
            if (!/\.db(?:-wal|-shm|-journal)?$/.test(path)) continue;
            databases.push(`${pid}:${path}`);
            const resolved = path.startsWith("/private/") ? path : `/private${path}`;
            if (!path.startsWith(root) && !resolved.startsWith(root)) {
                throw new Error(`${phase}: PID ${pid} holds ${path} outside the drill root`);
            }
        }
    }
    log("lsof", { phase, pids: [...pids], databases });
}

function toolUse(name: string, input: Record<string, unknown>, id: string) {
    return {
        content: [{ type: "tool_use", id, name, input }],
        stop_reason: "tool_use" as const,
        usage: { input_tokens: 500, output_tokens: 20, cache_creation_input_tokens: 100 },
    };
}

/** Text of the tool_result a later request carried for this tool_use id. */
function toolResult(h: RustTestHarness, id: string): string {
    for (const request of [...h.mock.requests()].reverse()) {
        for (const message of (request.body.messages ?? []) as Array<{ content?: unknown }>) {
            if (!Array.isArray(message.content)) continue;
            for (const block of message.content as Array<Record<string, unknown>>) {
                if (block.type === "tool_result" && block.tool_use_id === id) {
                    return JSON.stringify(block.content);
                }
            }
        }
    }
    throw new Error(`no tool_result for ${id}`);
}

const pending = new Map<string, ReturnType<typeof toolUse>>();
async function callTool(
    h: RustTestHarness,
    sessionId: string,
    name: string,
    input: Record<string, unknown>,
): Promise<string> {
    const id = `toolu_drill_${name}_${pending.size}_${Date.now()}`;
    const marker = `DRILL_CALL ${id}`;
    pending.set(marker, toolUse(name, input, id));
    await h.sendPrompt(sessionId, `${marker}: call ${name}`);
    const result = toolResult(h, id);
    log("tool", { name, input, result: result.slice(0, 400) });
    return result;
}

function lastUserText(body: Record<string, unknown>): string {
    const messages = (body.messages ?? []) as Array<{ role?: string; content?: unknown }>;
    const last = messages.at(-1);
    return last?.role === "user" ? JSON.stringify(last.content) : "";
}

const harness = await RustTestHarness.create({
    existingEnv: env,
    startInTsMode: false,
    modelContextLimit: 30_000,
    historianModelContextLimit: 128_000,
    magicContextConfig: {
        execute_threshold_percentage: 25,
        protected_tags: 1,
        compressor: { enabled: false },
        memory: { enabled: true, injection_budget_tokens: 4_000 },
        embedding: { provider: "off" },
        dreamer: { disable: true },
    },
});
const h = harness;
h.mock.addMatcher((body) => {
    const text = lastUserText(body as Record<string, unknown>);
    for (const [marker, response] of pending) {
        // A tool call answers only the user turn that names it; the follow-up request
        // after the tool result falls through to the default text reply.
        if (text.includes(marker) && !text.includes("tool_result")) {
            pending.delete(marker);
            return response;
        }
    }
    return null;
});

let failed: unknown;
try {
    const sessionId = await h.createSession();
    log("session", { sessionId, hostPid: h.opencode.pid, mode });

    if (mode === "refusal") {
        let refusal = "";
        try {
            await h.sendPrompt(sessionId, "unmigrated store, Rust mode", { timeoutMs: 60_000 });
        } catch (error) {
            refusal = String(error);
        }
        const messages = JSON.stringify((await h.client.session.messages({ path: { id: sessionId } })).data);
        const pluginLog = existsSync(h.logPath) ? await Bun.file(h.logPath).text() : "";
        const shown = /MC-C14|one-time migration/.test(messages) || /MC-C14|one-time migration/.test(refusal);
        const match = /.{0,160}(?:MC-C14|one-time migration).{0,160}/.exec(messages);
        log("rust-refusal", {
            shownInSession: shown,
            excerpt: match?.[0],
            inLog: /MC-C14|one-time migration/.test(pluginLog),
            refusal: refusal.slice(0, 400),
        });
        if (!shown) throw new Error("Rust mode on an unmigrated store did not surface MC-C14 in the session");
        auditOpenFiles("refusal-rust", h.opencode.pid);
        await h.restart({ rust: false });
        const tsSession = await h.createSession();
        await h.sendPrompt(tsSession, "unmigrated store, TS mode still serves");
        log("ts-on-unmigrated", { served: true, sessionId: tsSession });
        auditOpenFiles("refusal-ts", h.opencode.pid);
    } else {
        // 1. First Rust render and steady defers.
        for (let i = 1; i <= 4; i += 1) await h.sendPrompt(sessionId, `drill warmup ${i}`);
        const first = await h.waitForRustPasses(4, 60_000);
        log("first-passes", { decisions: first.map((p) => `${p.decision}/${p.reason}`) });
        auditOpenFiles("first-render", h.opencode.pid);

        // 2. Memory mutations through the real tools.
        const written = await callTool(h, sessionId, "ctx_memory", {
            action: "write",
            category: "ARCHITECTURE",
            content: "B2 drill memory: the single store keeps compartments in context.db.",
        });
        const memoryId = Number(/ID[^0-9]{0,4}(\d+)/.exec(written)?.[1]);
        if (!Number.isSafeInteger(memoryId)) throw new Error(`no memory id in ${written}`);
        const updated = await callTool(h, sessionId, "ctx_memory", {
            action: "update",
            ids: [memoryId],
            content: "B2 drill memory (updated): compartments and memories share context.db.",
        });
        const archived = await callTool(h, sessionId, "ctx_memory", {
            action: "archive",
            ids: [memoryId],
            reason: "drill cleanup",
        });
        const row = h
            .contextDb()
            .query("SELECT status, content FROM memories WHERE id = ?")
            .get(memoryId) as { status: string; content: string } | null;
        log("memory-row", { memoryId, row, updated: updated.slice(0, 200), archived: archived.slice(0, 200) });
        if (row?.status !== "archived" || !row.content.includes("(updated)")) {
            throw new Error(`memory ${memoryId} did not end updated and archived in context.db`);
        }

        // 3. Note write, read, and search.
        await callTool(h, sessionId, "ctx_note", {
            action: "write",
            // ctx_note read lists titles, so the searchable marker sits in the title line.
            content: "B2 drill note ZEBRA-QUARTZ\nThe drill marker ctx_search must find.",
        });
        const notes = await callTool(h, sessionId, "ctx_note", { action: "read" });
        if (!notes.includes("ZEBRA-QUARTZ")) throw new Error("note read did not return the drill note");
        const search = await callTool(h, sessionId, "ctx_search", { query: "ZEBRA-QUARTZ drill marker" });
        if (!search.includes("ZEBRA-QUARTZ")) throw new Error("ctx_search did not find the drill note");

        // 4. Pressure until the historian folds, then wait for its rows in context.db.
        for (let i = 1; i <= 10; i += 1) {
            h.mock.setDefault({
                text: `assistant ${i}`,
                usage: { input_tokens: 3_000 * i, output_tokens: 20, cache_creation_input_tokens: 2_000 },
            });
            await h.sendPrompt(sessionId, `drill fold turn ${i} FOLDMARK_${i}: ${h.ballast(2_500)}`);
            await Bun.sleep(200);
        }
        const compartmentQuery = () =>
            h
                .contextDb()
                .query(
                    "SELECT sequence, start_message, end_message, start_message_id, end_message_id, start_block_index, end_block_index FROM compartments WHERE session_id = ? ORDER BY sequence",
                )
                .all(sessionId) as Array<Record<string, unknown>>;
        let compartments = compartmentQuery();
        for (let i = 11; compartments.length === 0 && i <= 30; i += 1) {
            h.mock.setDefault({
                text: `post ${i}`,
                usage: { input_tokens: 8_000, output_tokens: 20, cache_creation_input_tokens: 2_000 },
            });
            await h.sendPrompt(sessionId, `drill fold follow-up ${i}: ${h.ballast(300)}`);
            await Bun.sleep(500);
            compartments = compartmentQuery();
        }
        const passes = await h.waitForRustPasses(1, 60_000);
        log("fold", {
            compartments,
            decisions: passes.slice(-12).map((p) => `${p.decision}/${p.reason}`),
            headHasHistory: JSON.stringify(h.lastMainMessages()[0]).includes("<session-history>"),
        });
        if (compartments.length === 0) throw new Error("no historian compartment landed in context.db");
        auditOpenFiles("fold", h.opencode.pid);

        // 5. ctx_expand over the folded range returns the original turns.
        const folded = compartments[0] as { start_message: number; end_message: number };
        const expanded = await callTool(h, sessionId, "ctx_expand", {
            start: folded.start_message,
            end: folded.end_message,
        });
        log("expand", { range: [folded.start_message, folded.end_message], bytes: expanded.length });
        if (!/drill (warmup|fold turn)|DRILL_CALL|FOLDMARK_/.test(expanded)) {
            throw new Error("ctx_expand did not return original folded messages");
        }

        // 6. Restarts: the history head must survive a module and a host restart. Folds
        // can still be landing from the pressure turns, so first wait until two
        // consecutive defers serve the same head over an unchanged compartment count.
        let headBefore = "";
        let countBefore = -1;
        for (let i = 1; i <= 15; i += 1) {
            h.mock.setDefault({
                text: `settle ${i}`,
                usage: { input_tokens: 2_000, output_tokens: 20, cache_read_input_tokens: 1_500 },
            });
            await h.sendPrompt(sessionId, `drill settle ${i}`);
            await Bun.sleep(1_000);
            const head = JSON.stringify(h.lastMainMessages()[0]);
            const count = compartmentQuery().length;
            if (head === headBefore && count === countBefore) break;
            headBefore = head;
            countBefore = count;
        }
        log("settled", { compartments: countBefore });
        await h.subc.restartModule();
        await h.sendPrompt(sessionId, "after module restart");
        const headAfterModule = JSON.stringify(h.lastMainMessages()[0]);
        await h.restart({ rust: true });
        await h.sendPrompt(sessionId, "after host restart");
        const headAfterHost = JSON.stringify(h.lastMainMessages()[0]);
        log("restart", {
            moduleRestartHeadIdentical: headAfterModule === headBefore,
            hostRestartHeadIdentical: headAfterHost === headBefore,
        });
        if (headAfterModule !== headBefore || headAfterHost !== headBefore) {
            throw new Error("history head changed across a restart");
        }
        auditOpenFiles("restart", h.opencode.pid);

        // 7. Rust -> TS -> Rust on the same session and store.
        await h.restart({ rust: false });
        await h.sendPrompt(sessionId, "switched to TS");
        const tsHead = JSON.stringify(h.lastMainMessages()[0]);
        await h.sendPrompt(sessionId, "TS defer");
        const tsDefer = JSON.stringify(h.lastMainMessages()[0]);
        auditOpenFiles("ts-mode", h.opencode.pid);
        await h.restart({ rust: true });
        await h.sendPrompt(sessionId, "back to Rust");
        const backPasses = await h.waitForRustPasses(1, 60_000);
        log("switch", {
            tsHeadHasHistory: tsHead.includes("<session-history>"),
            tsDeferIdentical: tsDefer === tsHead,
            backToRust: backPasses.slice(-2).map((p) => `${p.decision}/${p.reason}`),
        });
        if (!tsHead.includes("<session-history>") || tsDefer !== tsHead) {
            throw new Error("TS mode did not serve the shared history stably");
        }
        auditOpenFiles("back-to-rust", h.opencode.pid);
    }
    log("done", { mode, ok: true });
} catch (error) {
    failed = error;
    log("failed", { error: String(error) });
    try {
        console.error(h.subc.moduleLog().slice(-3000));
    } catch {
        // diagnostics only
    }
} finally {
    await h.dispose();
}
if (failed) process.exit(1);
