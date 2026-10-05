import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, rmSync, statSync, writeFileSync, readFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { isolate } from "./bootstrap";
import { measure, type Event } from "./measure";
import type { Variant } from "./engine";
import { prompts, scenarios } from "./scenarios";

const stagedAuth = join(tmpdir(), "magic-context", "self-tag-trial", "creds", "auth.json");
const hostBinary = join(tmpdir(), "magic-context", "self-tag-trial", "host", "node_modules", ".bin", "opencode");
const liveHome = homedir();
if (!existsSync(stagedAuth) || (statSync(stagedAuth).mode & 0o777) !== 0o600) throw new Error("Staged credential absent or not mode 600");
const out = resolve(process.argv[2] ?? "docs/reports/issue-582-self-tag-live");
const resumeVariant = process.argv[4]?.startsWith("resume-") ? process.argv[4].slice(7) : null;
const resume = ["A", "B", "C", "D"].includes(resumeVariant ?? "");
const selected = process.env.SELF_TAG_VARIANTS?.split(",") as Variant[] | undefined;
if (selected?.some(v => !["A", "B", "C", "D"].includes(v))) throw new Error("Unknown variant");
const previous = resume ? JSON.parse(readFileSync(`${out}-summary.json`, "utf8")) : null;
const priorEvents: Event[] = resume ? readFileSync(join(previous.root, "capture.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line)) : [];
let priorTurn = 0;
let priorSession = "";
for (const event of priorEvents) {
    if (event.kind === "wire") priorSession = event.messages.at(-1)?.info.sessionID ?? priorSession;
    event.capturedSession = event.input?.sessionID ?? priorSession;
    if (event.kind === "wire") priorTurn = event.messages.filter((message: any) => message.info.id && message.info.role === "user" && !message.parts.some((part: any) => part.text?.includes("__SELF_TAG_FLUSH_ONLY__"))).length;
    event.userTurn = priorTurn;
}
const root = previous?.root ?? isolate();
if (previous && !root.startsWith(join(tmpdir(), "magic-context", "self-tag-trial") + "/")) throw new Error("Resume root escaped trial directory");
const { DeepSeekCaller } = await import("./live-adapter");
const supplement = process.argv[3] === "reduction-supplement";
const control = process.env.SELF_TAG_FRESH_CONTROL === "1";
const trialScenarios = supplement ? ["reduced"] as const : control ? ["fresh"] as const : scenarios;
const summary: any = previous ?? { root, cohort: supplement ? "reduction-supplement" : "primary", model: "deepseek-flash", operatorModelLabel: "deepseek-v4.1-flash", rejectedSetupRequests: 0, version: "1.18.30", sessions: [], copiedCredentialDeleted: false, stagedCredentialDeleted: false };
const rows: unknown[] = resume ? readFileSync(`${out}.jsonl`, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)).filter(row => row.variant !== resumeVariant) : [];
let caller: Awaited<ReturnType<typeof DeepSeekCaller.create>> | undefined;
let completed = false;
function save(): void {
    writeFileSync(`${out}.jsonl`, rows.map(row => JSON.stringify(row)).join("\n") + (rows.length ? "\n" : ""));
    writeFileSync(`${out}-summary.json`, JSON.stringify({ ...summary, calls: caller?.calls ?? [] }, null, 2));
}
try {
    mkdirSync(join(root, "work"), { recursive: true });
    execFileSync("git", ["init", "--quiet"], { cwd: join(root, "work") });
    caller = await DeepSeekCaller.create(root, liveHome, stagedAuth, hostBinary);
    if (previous) {
        caller.calls.push(...previous.calls);
        summary.resumedForPendingFlush = true;
    }
    summary.isolationBefore = caller.isolation();
    for (let replicate = 0; replicate < (supplement || control ? 1 : 2); replicate++) for (let s = 0; s < trialScenarios.length; s++) {
        const scenario = trialScenarios[s];
        const order = selected ?? ((replicate + s) % 2 ? ["B", "A"] as const : ["A", "B"] as const);
        for (const variant of order) {
            if (previous && variant !== resumeVariant) continue;
            const resumed = previous && variant === resumeVariant;
            const oldRecord = previous?.sessions.find((session: any) => session.variant === resumeVariant);
            const session = resumed ? oldRecord.session : await caller.start(variant, scenario);
            if (resumed) {
                caller.session = session;
                caller.requireDroppedTag = oldRecord.reductionTarget;
                writeFileSync(join(root, "control.json"), JSON.stringify({ variant, head: false }));
            }
            const record: any = resumed ? oldRecord : { session, variant, scenario, replicate: replicate + 1, prompts: [], providerCallStart: caller.calls.length, snapshots: [], completed: false };
            if (!resumed) summary.sessions.push(record);
            const events: Event[] = resumed ? priorEvents.filter(event => event.kind !== "flush" && (event.input?.sessionID === session || event.messages?.some((message: any) => message.info.sessionID === session) || event.kind === "system" && event.capturedSession === session)) : [];
            const turnPrompts = resumed ? [...record.prompts, "Flush the pending fixture reduction.", "What is 3 plus 4? Explain in one sentence."] : prompts(scenario);
            if (supplement && !resumed) turnPrompts.push("Flush the pending fixture reduction.", "What is 3 plus 4? Explain in one sentence.");
            for (let turn = resumed ? record.prompts.length : 0; turn < turnPrompts.length; turn++) {
                if (supplement && !resumed && turn === 16) {
                    const calls = [...caller.calls];
                    await caller.close();
                    // Reducing history changes the cached provider prompt prefix. Wait out its five-minute
                    // reuse window so the scheduler can reclaim history without sacrificing that cache.
                    record.cacheExpiryWaitMs = 301000;
                    await Bun.sleep(record.cacheExpiryWaitMs);
                    caller = await DeepSeekCaller.create(root, liveHome, stagedAuth, hostBinary);
                    caller.calls.push(...calls);
                    caller.session = session;
                    caller.requireDroppedTag = record.reductionTarget;
                    writeFileSync(join(root, "control.json"), JSON.stringify({ variant, head: false }));
                    record.restartedBeforeTurn = 17;
                }
                let prompt = turnPrompts[turn];
                if (scenario === "reduced" && turn === 9) {
                    const db = new Database(join(root, "data", "cortexkit", "magic-context", "context.db"), { readonly: true });
                    try {
                        const target = db.query("SELECT tag_number FROM tags WHERE session_id = ? AND type = 'tool' ORDER BY tag_number DESC LIMIT 1 OFFSET 2").get(session) as { tag_number: number } | null;
                        if (!target) throw new Error("Reduction scenario has no completed tool target");
                        prompt = `Queue ctx_reduce with drop: "${target.tag_number}" for that completed fixture tool output, which is no longer needed. Then explain the total without rereading. Do not drop any other tag.`;
                        record.reductionTarget = target.tag_number;
                    } finally { db.close(); }
                }
                if (scenario === "reduced" && turn === 10) {
                    if (supplement) prompt = "Call trial_read with padding=true to load the large deterministic reference fixture. Ignore its reference appendix when answering. After the tool returns, summarize apples=3, pears=4, total=7 in one sentence.";
                    else prompt += "\nReference scratch pad, not part of the fruit counts; ignore it when answering:\n<fixture-padding>\n" + "reference line: alpha beta gamma delta epsilon zeta eta theta iota kappa\n".repeat(500) + "</fixture-padding>";
                }
                if (supplement && (turn === 11 && !resumed || turn === 16)) {
                    const db = new Database(join(root, "data", "cortexkit", "magic-context", "context.db"), { readonly: true });
                    try {
                        const fresh = db.query("SELECT tag_number FROM tags t WHERE session_id = ? AND type = 'tool' AND status = 'active' AND tag_number < ? AND NOT EXISTS (SELECT 1 FROM pending_ops p WHERE p.session_id = t.session_id AND p.tag_id = t.tag_number) ORDER BY tag_number LIMIT 1").get(session, record.reductionTarget) as { tag_number: number } | null;
                        if (!fresh) throw new Error("No fresh older tool output can trigger pending reduction flush");
                        prompt = `Call ctx_reduce with drop: "${record.reductionTarget},${fresh.tag_number}" to flush the queued fixture output and reclaim the earlier completed tool output. Then explain the fruit total in one sentence.`;
                        record.flushTarget = fresh.tag_number;
                    } finally { db.close(); }
                }
                record.prompts.push(prompt);
                const batch = (await caller.send(prompt) as Event[]).map(e => ({ ...e, userTurn: turn + 1 }));
                events.push(...batch);
                if (turn === 0 || turn === 9) record.snapshots.push(...batch.filter(e => e.kind === "wire"));
                record.lastCompletedTurn = turn + 1;
                save();
                console.log(`${variant} ${scenario} replicate ${replicate + 1}: turn ${turn + 1}/${turnPrompts.length}; provider calls=${caller.calls.length}`);
            }
            const flush = (await caller.flush() as Event[]).map(e => ({ ...e, userTurn: turnPrompts.length + 1 }));
            events.push(...flush);
            if (!flush.some(e => e.kind === "flush")) throw new Error("No final-reply flush evidence");
            record.snapshots.push(...flush.filter(e => e.kind === "wire"));
            record.isolation = caller.isolation();
            const db = new Database(join(root, "data", "cortexkit", "magic-context", "context.db"), { readonly: true });
            try {
                const sessionRows = measure(events, session, variant, scenario, (messageID, partIndex) => {
                    const row = db.query("SELECT tag_number FROM tags WHERE session_id = ? AND message_id = ?").get(session, `${messageID}:p${partIndex}`) as { tag_number: number } | null;
                    return row?.tag_number ?? null;
                });
                if (sessionRows.some(r => r.byteIdentity === null)) throw new Error("Reply lacks a next-pass observation");
                record.rows = sessionRows.length;
                record.replies = Math.max(...sessionRows.map(r => r.position));
                record.providerCallEnd = caller.calls.length;
                const calls = caller.calls.slice(record.providerCallStart, record.providerCallEnd);
                const providerTexts = calls.filter(call => call.text).map(call => call.text);
                const hookTexts = events.filter(e => e.kind === "raw").map(e => e.text);
                record.providerHookTextEqual = JSON.stringify(providerTexts) === JSON.stringify(hookTexts);
                if (!record.providerHookTextEqual) throw new Error("Provider stream and pre-strip hook text differ");
                if (calls.length !== record.replies) throw new Error("Provider call count differs from observed assistant replies");
                for (const row of sessionRows) {
                    const provider = calls[row.position - 1];
                    if (!provider.responseModel) throw new Error("Provider response omitted model identity");
                    Object.assign(row, { model: provider.responseModel, requestedModel: provider.model,
                        providerCallIndex: provider.index, responseModel: provider.responseModel, usage: provider.usage,
                        reasoning: provider.reasoning, reasoningTokens: provider.reasoningTokens, finish: provider.finish,
                        providerToolCalls: provider.calls,
                        reasoningReplays: events.filter(e => e.kind === "wire").flatMap(e => e.messages).filter((m: any) => m.info.id === row.messageID).map((m: any) => m.parts.filter((p: any) => p.type === "reasoning").map((p: any) => p.text)),
                        providerArgumentTags: provider.calls.some(call => /§/.test(String(call.arguments ?? ""))) });
                    row.misplaced ||= provider.calls.some(call => /§/.test(String(call.arguments ?? "")));
                }
                record.responseModels = [...new Set(calls.map(call => call.responseModel))];
                record.nativeToolCalls = events.filter(e => e.kind === "tool").map(e => ({ input: e.input, args: e.args, userTurn: e.userTurn }));
                record.placeholderSeen = events.filter(e => e.kind === "wire").some(e => JSON.stringify(e.messages).includes("[dropped §"));
                record.parallelSeen = calls.some(call => call.calls.length > 1);
                record.providerSawReductionTarget = calls.some(call => call.servedDroppedTags.includes(record.reductionTarget));
                if (supplement) {
                    const tag = db.query("SELECT status FROM tags WHERE session_id = ? AND tag_number = ?").get(session, record.reductionTarget) as { status: string } | null;
                    record.reductionStatus = tag?.status;
                    if (!record.placeholderSeen || !record.providerSawReductionTarget || tag?.status !== "dropped") throw new Error("Queued reduction never reached the model as a real tool-result placeholder");
                }
                record.guidance = events.find(e => e.kind === "system" && e.system.some((text: string) => text.includes("## Magic Context")))?.system;
                record.completed = true;
                rows.push(...sessionRows);
            } finally { db.close(); }
            save();
        }
    }
    completed = true;
} finally {
    await caller?.close();
    summary.copiedCredentialDeleted = !existsSync(join(root, "data", "opencode", "auth.json"));
    if (completed && process.env.SELF_TAG_KEEP_STAGED !== "1") rmSync(stagedAuth, { force: true });
    summary.stagedCredentialDeleted = !existsSync(stagedAuth);
    summary.completed = completed;
    save();
}
console.log(`Completed live DeepSeek trial; ${rows.length} rows; copied credential deleted; staged retention recorded in summary.`);
