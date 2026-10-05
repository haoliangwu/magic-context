// Render the actual built Solid dashboard in an isolated Chrome profile, using
// native DTOs captured by db::perf_ui::native_dashboard_audit. No live API or
// host store is contacted. timeout 600 bun .../dashboard-browser.ts <root>
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(process.argv[2] ?? "");
if (!process.argv[2]) throw new Error("throwaway root required");
const dist = new URL("../../../dashboard/dist/", import.meta.url).pathname;
const before = readFileSync(join(root, "native-before-ipc.json"), "utf8");
const after = readFileSync(join(root, "native-after-ipc.json"), "utf8");
const detail = JSON.parse(readFileSync(join(root, "native-detail.json"), "utf8")) as { harness: string; session_id: string; title: string; project_identity: string; project_display: string };
const stats = JSON.parse(readFileSync(join(root, "native-cache-stats.json"), "utf8")) as { harness: string; session_id: string }[];
const windows = JSON.parse(readFileSync(join(root, "native-cache-windows.json"), "utf8")) as unknown[][];
const counts = new Map<string, number>();
let payload = before;
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path !== "/api/invoke") return new Response(Bun.file(join(dist, path === "/" ? "index.html" : path)));
    const { cmd, args } = await request.json() as { cmd: string; args: Record<string, unknown> };
    counts.set(cmd, (counts.get(cmd) ?? 0) + 1);
    if (cmd === "get_session_messages") return new Response(payload, { headers: { "Content-Type": "application/json" } });
    const card = { identity: detail.project_identity, display_name: "Audit", primary_path: root, harnesses: [detail.harness], session_count: 1, memory_count: 0, last_activity_ms: 1 };
    const row = { harness: detail.harness, session_id: detail.session_id, title: detail.title, project_identity: detail.project_identity, project_display: detail.project_display, last_activity_ms: 1, is_subagent: false };
    const responses: Record<string, unknown> = {
        get_db_health: { found: true, path: root, size_bytes: 1, tables: [], error: null },
        get_model_catalogs: { opencode: [], pi: [], omp: [] }, get_opencode_install_state: "none",
        get_project_cards: [card], get_projects: [], get_session_detail: detail,
        list_sessions_paged: { rows: [row], total: 1, has_more: false, conditions: [] },
        get_session_cache_stats_from_db: stats, get_smart_notes: [],
        get_memories: [], get_memory_stats: { total: 0, active: 0, permanent: 0, archived: 0, with_embeddings: 0, categories: [] },
        enumerate_memory_projects: [], list_workspace_summaries: [], get_mural: null,
        get_dreamer_projects: [], get_dream_state: [], get_dream_runs: [], get_log_paths: [], get_log_entries: [],
    };
    if (cmd.startsWith("get_session_cache_events")) {
        const index = stats.findIndex((s) => s.harness === args.harness && s.session_id === args.sessionId);
        return Response.json(index < 0 ? [] : windows[index] ?? []);
    }
    return Response.json(responses[cmd] ?? []);
}});
const profile = join(root, "chrome-profile");
mkdirSync(profile, { recursive: true });
const chrome = Bun.spawn(["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "--headless=new", "--no-first-run", "--no-default-browser-check", "--disable-background-networking", "--disable-extensions", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank"], { stdout: "ignore", stderr: "pipe" });
let socket: WebSocket | undefined;
try {
    let output = "";
    let endpoint = "";
    for await (const chunk of chrome.stderr) {
        output += new TextDecoder().decode(chunk);
        const match = /DevTools listening on (ws:\/\/\S+)/.exec(output);
        if (match) { endpoint = match[1]!; break; }
    }
    if (!endpoint) throw new Error("Chrome did not expose a debugging endpoint");
    socket = new WebSocket(endpoint);
    await new Promise<void>((done, fail) => { socket!.onopen = () => done(); socket!.onerror = () => fail(new Error("Chrome connection failed")); });
    let id = 0;
    const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
    socket.onmessage = (event) => {
        const message = JSON.parse(String(event.data)) as { id?: number; result?: unknown; error?: unknown };
        const waiter = message.id === undefined ? undefined : pending.get(message.id);
        if (waiter) { pending.delete(message.id!); if (message.error) waiter.reject(new Error(JSON.stringify(message.error))); else waiter.resolve(message.result); }
    };
    const send = <T>(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<T> => new Promise((done, fail) => {
        const command = ++id;
        const timer = setTimeout(() => { pending.delete(command); fail(new Error(`${method} timed out`)); }, 60000);
        pending.set(command, { resolve: (value) => { clearTimeout(timer); done(value as T); }, reject: (error) => { clearTimeout(timer); fail(error); } });
        socket!.send(JSON.stringify({ id: command, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
    const target = await send<{ targetId: string }>("Target.createTarget", { url: "about:blank" });
    const attached = await send<{ sessionId: string }>("Target.attachToTarget", { targetId: target.targetId, flatten: true });
    const sid = attached.sessionId;
    const evaluate = async <T>(expression: string) => {
        const result = await send<{ result: { value: T }; exceptionDetails?: unknown }>("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, sid);
        if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
        return result.result.value;
    };
    await send("Page.enable", {}, sid);
    // MutationObserver waits for real Solid resource updates rather than
    // assuming an arbitrary sleep is long enough on a congested machine.
    const waitFor = async (selector: string) => evaluate(`new Promise((done, fail) => { const check=()=>{if(document.querySelector(${JSON.stringify(selector)})){observer.disconnect();done(true)}}; const observer=new MutationObserver(check); observer.observe(document,{childList:true,subtree:true}); check(); setTimeout(()=>{observer.disconnect();fail(new Error('selector not reached'))},30000) })`);
    const hashes: string[] = [];
    for (const [label, wire] of [["before", before], ["after", after]] as const) {
        payload = wire; counts.clear();
        await send("Page.navigate", { url: server.url.href }, sid);
        await waitFor(".project-card");
        await evaluate("document.querySelector('.project-card').click()");
        await waitFor(".project-detail-body button.card");
        await evaluate("document.querySelector('.project-detail-body button.card').click()");
        await waitFor(".tab-pill");
        const measurement = await evaluate<{ elapsedMs: number; cards: number; text: string }>(`new Promise(done => { const start=performance.now(); [...document.querySelectorAll('.tab-pill')].find(b=>b.textContent.startsWith('Messages')).click(); const check=()=>{ const loading=document.body.textContent.includes('Loading messages'); if(!loading && document.querySelector('.list-gap')) { observer.disconnect(); requestAnimationFrame(()=>requestAnimationFrame(()=>done({elapsedMs:performance.now()-start,cards:document.querySelectorAll('.scroll-area .card').length,text:document.querySelector('.scroll-area').innerText}))) } }; const observer=new MutationObserver(check); observer.observe(document,{childList:true,subtree:true}); check(); })`);
        hashes.push(createHash("sha256").update(measurement.text).digest("hex"));
        const parse = await evaluate<{ parseMs: number; rows: number }>(`(()=>{const wire=${JSON.stringify(wire)};const start=performance.now();const rows=JSON.parse(wire);return{parseMs:performance.now()-start,rows:rows.length}})()`);
        console.log(JSON.stringify({ label, IPCBytes: Buffer.byteLength(wire), ...parse, renderAndFetchMs: measurement.elapsedMs, cards: measurement.cards, displayTextSha256: hashes.at(-1), calls: Object.fromEntries(counts) }));
    }
    if (hashes[0] !== hashes[1]) throw new Error("message tab display text changed with compact IPC");
} finally {
    socket?.close(); chrome.kill(); await chrome.exited; server.stop(true);
}
