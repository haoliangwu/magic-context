/** Capture OpenCode 1.18.30's real serializers without contacting a model service.
 * Usage: bun packages/e2e-tests/src/repro/reasoning-cleanup-per-provider.ts --opencode /absolute/binary --out /tmp/mc-reasoning-wire-UNIQUE
 * The endpoint deliberately rejects every request: captures prove wire shape, not API acceptance.
 */
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

const arg = (key: string) => {
	const i = process.argv.indexOf(`--${key}`);
	if (i < 0 || !process.argv[i + 1]) throw new Error(`Missing --${key}`);
	return process.argv[i + 1]!;
};
const out = resolve(arg("out"));
const temp = resolve(tmpdir());
if (!out.startsWith(`${temp}/mc-reasoning-wire-`) || existsSync(out))
	throw new Error("Use a new mc-reasoning-wire-* root beneath the system temp directory");
const binary = resolve(arg("opencode"));
const dirs = Object.fromEntries(
	["home", "config", "data", "cache", "state", "runtime", "work", "tmp"].map((k) => [k, join(out, k)]),
) as Record<string, string>;
for (const dir of Object.values(dirs)) mkdirSync(dir, { recursive: true });
const routes = [
	{ id: "anthropic", npm: "@ai-sdk/anthropic", model: "claude-sonnet-5" },
	{ id: "vertex-eu-anthropic", npm: "@ai-sdk/google-vertex/anthropic", model: "claude-sonnet-5" },
	{ id: "bedrock-probe", npm: "@ai-sdk/amazon-bedrock", model: "anthropic.claude-sonnet-5" },
	{ id: "copilot-probe", npm: "@ai-sdk/github-copilot", model: "claude-sonnet-5" },
	{ id: "openai", npm: "@ai-sdk/openai", model: "gpt-5" },
	{ id: "codex-probe", npm: "@ai-sdk/openai", model: "gpt-5" },
	{ id: "gemini-probe", npm: "@ai-sdk/google", model: "gemini-2.5-pro" },
	{ id: "deepseek-probe", npm: "@ai-sdk/openai-compatible", model: "deepseek-reasoner" },
	{ id: "groq-probe", npm: "@ai-sdk/groq", model: "deepseek-r1-distill-llama-70b" },
	{ id: "xai-probe", npm: "@ai-sdk/xai", model: "grok-3-mini" },
];
const captures: Array<{ path: string; beta: string | null; body: unknown }> = [];
const mock = Bun.serve({
	hostname: "127.0.0.1", port: 0,
	async fetch(req) {
		captures.push({ path: new URL(req.url).pathname, beta: req.headers.get("anthropic-beta"), body: await req.json() });
		return Response.json({ type: "error", error: { type: "invalid_request_error", message: "Recording endpoint: deliberate rejection" } }, { status: 400 });
	},
});
const baseURL = `http://127.0.0.1:${mock.port}`;
const plugin = join(out, "fixture-plugin.mjs");
writeFileSync(plugin, `export const Fixture = async () => ({
  config: async (config) => {
    config.provider['vertex-eu-anthropic'].options.generateAuthToken = async () => 'mock-only';
  },
  'experimental.chat.messages.transform': async (_, output) => {
    const last = output.messages.findLast(m => m.info.role === 'user');
    const marker = last.parts.find(p => p.type === 'text').text;
    const [providerID, modelID, mode] = marker.split('|');
    const metadata = {
      [providerID]: providerID.includes('bedrock') ? {signature:'mock-signature'} :
        providerID.includes('gemini') ? {thoughtSignature:'mock-thought-signature'} :
        providerID.includes('copilot') ? {reasoningOpaque:'mock-opaque'} :
        providerID === 'openai' || providerID === 'codex-probe' ? {itemId:'rs_mock', reasoningEncryptedContent:'mock-encrypted'} :
        {signature:'mock-signature'},
      anthropic: {signature:'mock-signature'},
      google: {thoughtSignature:'mock-thought-signature'},
      openai: {itemId:'rs_mock', reasoningEncryptedContent:'mock-encrypted'}
    };
    let parts = [
      {id:'prt_fixture_reason', type:'reasoning', text:mode === 'cleared' ? '[cleared]' : mode === 'empty-reasoning' ? '' : 'OLD_REASONING_FIXTURE', metadata:mode === 'unsigned' ? undefined : metadata},
      {id:'prt_fixture_answer', type:'text', text:'OLD_ANSWER_FIXTURE'}
    ];
    if (mode === 'removed') parts.shift();
    if (mode === 'sentinel') parts[0] = {id:'prt_fixture_reason', type:'text', text:''};
    output.messages.unshift(
      {info:{id:'msg_fixture_user',role:'user',time:{created:1}},parts:[{id:'prt_fixture_user',type:'text',text:'OLD_QUESTION_FIXTURE'}]},
      {info:{id:'msg_fixture_assistant',role:'assistant',providerID,modelID,time:{created:2},tokens:{input:0,output:0,reasoning:0,cache:{read:0,write:0}},cost:0,finish:'stop'},parts}
    );
  }
});`);
const provider = Object.fromEntries(routes.map((r) => [r.id, {
	npm: r.npm, env: [], options: { apiKey: "mock-only", baseURL, region: "us-east-1", project: "mock-project", location: "eu", name: r.id },
	models: { [r.model]: { name: r.model, reasoning: true, limit: { context: 200000, output: 2048 }, options: {
		store: false, contextManagement: { edits: [{ type: "clear_thinking_20251015", keep: { type: "thinking_turns", value: 1 } }] },
	} } },
}]));
writeFileSync(join(dirs.config!, "opencode.json"), JSON.stringify({
	plugin: [`file://${plugin}`], provider, enabled_providers: routes.map(r => r.id),
	model: "anthropic/claude-sonnet-5", small_model: "anthropic/claude-sonnet-5",
	autoupdate: false, share: "disabled", compaction: { auto: false, prune: false },
}, null, 2));
const env = {
	PATH: process.env.PATH!, HOME: dirs.home!, XDG_CONFIG_HOME: dirs.config!, XDG_DATA_HOME: dirs.data!,
	XDG_CACHE_HOME: dirs.cache!, XDG_STATE_HOME: dirs.state!, XDG_RUNTIME_DIR: dirs.runtime!,
	OPENCODE_CONFIG_DIR: dirs.config!, OPENCODE_DB: join(dirs.data!, "opencode", "wire.db"),
	MAGIC_CONTEXT_STORAGE_DIR: join(dirs.data!, "mc"), MAGIC_CONTEXT_LOG_PATH: join(out, "mc.log"),
	TMPDIR: dirs.tmp!, OPENCODE_DISABLE_AUTOUPDATE: "true", OPENCODE_DISABLE_MODELS_FETCH: "true",
};
const version = Bun.spawnSync([binary, "--version"], { env }).stdout.toString().trim();
if (version !== "1.18.30") throw new Error(`Expected 1.18.30, got ${version}`);
const port = 22000 + Math.floor(Math.random() * 20000);
const child = spawn(binary, ["serve", "--hostname", "127.0.0.1", "--port", String(port), "--print-logs"], { cwd: dirs.work, env, stdio: ["ignore", "pipe", "pipe"] });
let logs = "";
child.stdout?.on("data", c => logs += c);
child.stderr?.on("data", c => logs += c);
const url = `http://127.0.0.1:${port}`;
function isolation(name: string) {
	const p = Bun.spawnSync(["lsof", "-p", String(child.pid)]);
	if (p.exitCode !== 0) throw new Error("lsof failed");
	const text = p.stdout.toString();
	writeFileSync(join(out, name), text);
	const rows = text.split("\n").filter(l => /REG/.test(l) && /\.db(?:-|\s|$)/.test(l));
	if (!rows.length || rows.some(l => !l.includes(out))) throw new Error("Database isolation failed");
}
const results: unknown[] = [];
try {
	let ready = false;
	for (let i = 0; i < 120; i++) {
		try { ready = (await fetch(`${url}/session`, { signal: AbortSignal.timeout(1000) })).ok; } catch {}
		if (ready) break;
		await Bun.sleep(500);
	}
	if (!ready) throw new Error("Host startup failed; see isolated host.log");
	isolation("lsof-before.txt");
	const api = async (path: string, body: unknown) => {
		const res = await fetch(`${url}${path}?directory=${encodeURIComponent(dirs.work!)}`, {
			method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(30000),
		});
		return { status: res.status, value: await res.json() };
	};
	for (const route of routes) for (const mode of ["intact", "cleared", "empty-reasoning", "sentinel", "removed", "unsigned"]) {
		const start = captures.length;
		try {
			const session = await api("/session", { title: "Reasoning serializer probe" });
			const id = (session.value as {id: string}).id;
			const response = await api(`/session/${id}/message`, {
				model: { providerID: route.id, modelID: route.model }, agent: "build",
				parts: [{ type: "text", text: `${route.id}|${route.model}|${mode}` }],
			});
			results.push({ route: route.id, mode, status: response.status, captures: captures.slice(start), response: response.value });
		} catch (error) { results.push({ route: route.id, mode, error: String(error), captures: captures.slice(start) }); }
	}
	isolation("lsof-after.txt");
	writeFileSync(join(out, "results.json"), JSON.stringify({ version, results }, null, 2));
	const missing = (results as Array<{route: string; mode: string; captures: unknown[]}>).filter(r => !r.captures.length);
	console.log(JSON.stringify({ out, version, cases: results.length, captures: captures.length, missing: missing.map(r => `${r.route}/${r.mode}`) }));
	if (missing.length) process.exitCode = 1;
} finally {
	child.kill("SIGTERM");
	await new Promise<void>(resolve => { if (child.exitCode !== null) resolve(); else child.once("exit", () => resolve()); });
	mock.stop(true);
	writeFileSync(join(out, "host.log"), logs);
}
