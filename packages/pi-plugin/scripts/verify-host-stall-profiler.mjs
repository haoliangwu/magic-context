#!/usr/bin/env node
/** Real CLI probe. All host state, copied bundles and evidence stay in a throwaway root. */
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import {
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"../../..",
);
const root = process.env.HOST_PROFILER_TEST_ROOT;
assert(
	root && path.isAbsolute(root) && root.includes("/magic-context/"),
	"HOST_PROFILER_TEST_ROOT must be an absolute throwaway magic-context path",
);
const kind = process.argv[2] ?? "pi";
assert(["pi", "omp"].includes(kind));
mkdirSync(root, { recursive: true });
const run = mkdtempSync(path.join(root, `${kind}-`));
const install = path.join(root, "install/node_modules");
const hostPackage = path.join(
	install,
	kind === "pi"
		? "@earendil-works/pi-coding-agent"
		: "@oh-my-pi/pi-coding-agent",
);
const manifest = JSON.parse(
	readFileSync(path.join(hostPackage, "package.json"), "utf8"),
);
const bin = path.join(
	hostPackage,
	typeof manifest.bin === "string"
		? manifest.bin
		: Object.values(manifest.bin)[0],
);
const env = {
	...process.env,
	HOME: path.join(run, "home"),
	TMPDIR: path.join(run, "tmp"),
	XDG_DATA_HOME: path.join(run, "data"),
	XDG_CONFIG_HOME: path.join(run, "config"),
	XDG_STATE_HOME: path.join(run, "state"),
	XDG_RUNTIME_DIR: path.join(run, "runtime"),
	XDG_CACHE_HOME: path.join(run, "cache"),
	OPENCODE_DB: path.join(run, "data/opencode.db"),
	MAGIC_CONTEXT_STORAGE_DIR: path.join(run, "storage"),
	MAGIC_CONTEXT_LOG_PATH: path.join(run, "magic-context.log"),
	PI_CODING_AGENT_DIR: path.join(
		run,
		"home",
		kind === "pi" ? ".pi/agent" : ".omp/agent",
	),
	OMP_AGENT_DIR: path.join(run, "home/.omp/agent"),
};
for (const variable of [
	"HOME",
	"TMPDIR",
	"XDG_DATA_HOME",
	"XDG_CONFIG_HOME",
	"XDG_STATE_HOME",
	"XDG_RUNTIME_DIR",
	"XDG_CACHE_HOME",
	"MAGIC_CONTEXT_STORAGE_DIR",
	"PI_CODING_AGENT_DIR",
	"OMP_AGENT_DIR",
])
	mkdirSync(env[variable], { recursive: true });
const cwd = path.join(run, "project");
mkdirSync(cwd, { recursive: true });
execFileSync("git", ["init", "-q", cwd], { env });
const copied = path.join(run, "magic-context");
mkdirSync(copied, { recursive: true });
if (!existsSync(path.join(run, "node_modules")))
	symlinkSync(install, path.join(run, "node_modules"), "dir");
cpSync(path.join(repo, "packages/pi-plugin/dist"), path.join(copied, "dist"), {
	recursive: true,
});
writeFileSync(
	path.join(copied, "package.json"),
	JSON.stringify({ name: "@cortexkit/pi-magic-context", type: "module" }),
);
const bundlePath = path.join(copied, "dist/index.js");
let bundle = readFileSync(bundlePath, "utf8");
const hook = "const contextHandler = async (event, ctx, budget) => {";
assert.equal(
	bundle.split(hook).length,
	2,
	"the test injection must target the actual context handler exactly once",
);
bundle = bundle.replace(
	hook,
	`${hook}\nif (globalThis.__hostProfilerContextStall) { globalThis.__hostProfilerContextStall = false; const until = performance.now() + 6000; while (performance.now() < until) {} }`,
);
// These hooks exist only in the throwaway copy, never in the shipped plugin.
const jscLoader = /loadJsc: \(\) => import\(([^)]+)\)/g;
assert.equal(
	[...bundle.matchAll(jscLoader)].length,
	1,
	"the Bun loader audit must reach the production loader",
);
bundle = bundle.replace(
	jscLoader,
	(_match, specifier) =>
		`loadJsc: () => { globalThis.__hostProfilerActivity?.("jsc.load"); return import(${specifier}); }`,
);
assert(
	bundle.includes("api.startSamplingProfiler();"),
	"the Bun sampler audit must reach the production start call",
);
bundle = bundle.replaceAll(
	"api.startSamplingProfiler();",
	'globalThis.__hostProfilerActivity?.("jsc.start"); api.startSamplingProfiler();',
);
assert(
	bundle.includes('const { Session } = await import("node:inspector");'),
	"the inspector import audit must reach the production import",
);
assert(
	bundle.includes("return new Session;"),
	"the inspector constructor audit must reach the production constructor",
);
bundle = bundle.replace(
	'const { Session } = await import("node:inspector");',
	'globalThis.__hostProfilerActivity?.("inspector.load"); const { Session } = await import("node:inspector");',
);
bundle = bundle.replace(
	"return new Session;",
	'globalThis.__hostProfilerActivity?.("inspector.construct"); return new Session;',
);
writeFileSync(bundlePath, bundle);
mkdirSync(path.join(env.XDG_CONFIG_HOME, "cortexkit"), { recursive: true });
writeFileSync(
	path.join(env.XDG_CONFIG_HOME, "cortexkit/magic-context.jsonc"),
	JSON.stringify({
		enabled: true,
		dreamer: { enabled: false },
		embedding: { provider: "off" },
		auto_update: false,
		historian: { enabled: false },
	}),
);

const server = createServer((_req, res) => {
	res.writeHead(200, { "content-type": "text/event-stream" });
	res.end(
		'data: {"id":"test","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant","content":"probe complete"},"finish_reason":null}]}\n\ndata: {"id":"test","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":20,"completion_tokens":2,"total_tokens":22}}\n\ndata: [DONE]\n\n',
	);
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = server.address().port;
writeFileSync(
	path.join(env.PI_CODING_AGENT_DIR, "models.json"),
	JSON.stringify({
		providers: {
			mock: {
				api: "openai-completions",
				baseUrl: `http://127.0.0.1:${port}/v1`,
				apiKey: "not-a-secret-test-only",
				models: [
					{
						id: "mock-model",
						name: "Mock",
						input: ["text"],
						contextWindow: 128000,
						maxTokens: 4096,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					},
				],
			},
		},
	}),
);
const extension = path.join(env.PI_CODING_AGENT_DIR, "extensions/stall-probe");
mkdirSync(extension, { recursive: true });
writeFileSync(
	path.join(extension, "package.json"),
	'{"name":"host-stall-test-extension","type":"module"}',
);
const probe = path.join(extension, "index.ts");
writeFileSync(
	probe,
	`
import { writeFileSync, mkdirSync, readdirSync, readFileSync, unlinkSync } from "node:fs";
import { Session } from "node:inspector";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
const root = ${JSON.stringify(run)};
const activity = [];
globalThis.__hostProfilerActivity = (method) => activity.push({ method, at: Date.now() });
for (const method of ["connect", "disconnect", "post"]) {
    const original = Session.prototype[method];
    Session.prototype[method] = function(...args) { globalThis.__hostProfilerActivity(method === "post" ? args[0] : method); return original.apply(this, args); };
}
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));
function deliberateBusyLoop() { const until = performance.now() + 6000; while (performance.now() < until) {} }
function deliberateSqliteCaller() {
    const db = new DatabaseSync(path.join(root, "storage/probe.db"));
    writeFileSync(path.join(root, "sqlite-active"), String(process.pid));
    const query = db.prepare("WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<200000) SELECT sum(x) FROM n");
    const until = performance.now() + 6000; while (performance.now() < until) query.get();
    db.close();
}
export default function(pi) {
    pi.on("session_start", () => {
        (async () => {
            writeFileSync(path.join(root, "ready.json"), JSON.stringify({ pid: process.pid, versions: process.versions }));
            const cpuOff = process.cpuUsage(); const atOff = performance.now();
            await delay(20000);
            const off = { cpu_percent: (process.cpuUsage(cpuOff).user + process.cpuUsage(cpuOff).system) / ((performance.now()-atOff)*10), activity: [...activity] };
            if (off.activity.length) throw new Error("profiler activity while switch absent");
            const dir = path.join(root, "storage/host-profiler"); mkdirSync(dir, { recursive: true });
            writeFileSync(path.join(dir, "enable"), "");
            await delay(6000);
            const cpuOn = process.cpuUsage(); const atOn = performance.now(); const windows = [process.memoryUsage()];
            for (let i=0; i<3; i++) { await delay(10000); windows.push(process.memoryUsage()); }
            const on = { cpu_percent: (process.cpuUsage(cpuOn).user + process.cpuUsage(cpuOn).system) / ((performance.now()-atOn)*10), windows };
            deliberateBusyLoop(); await delay(1000);
            deliberateSqliteCaller(); await delay(1000);
            globalThis.__hostProfilerContextStall = true;
            pi.sendUserMessage("Run the context stall probe and reply once.");
            await delay(9000);
            if (globalThis.__hostProfilerContextStall) throw new Error("Magic Context handler test hook was not reached");
            unlinkSync(path.join(dir, "enable")); await delay(6000);
            const count = activity.length; await delay(6000);
            if (activity.length !== count) throw new Error("profiler still active after disable");
            writeFileSync(path.join(dir, "enable"), ""); await delay(6000);
            deliberateBusyLoop(); await delay(1000);
            unlinkSync(path.join(dir, "enable")); await delay(6000);
            writeFileSync(path.join(root, "result.json"), JSON.stringify({ off, on, activity, reports: readdirSync(dir).filter(n=>n.startsWith("stall-")).sort().map(n=>JSON.parse(readFileSync(path.join(dir,n),"utf8"))) }, null, 2));
        })().catch(error => writeFileSync(path.join(root, "error.txt"), String(error.stack ?? error)));
    });
}
`,
);
const shebang = readFileSync(bin, "utf8").split("\n", 1)[0];
assert(
	/\b(?:node|bun)\b/.test(shebang),
	"the host CLI must declare its Node or Bun runtime",
);
const command = /\bbun\b/.test(shebang) ? "bun" : "node";
const args = [
	bin,
	"--mode",
	"rpc",
	"--no-session",
	"--provider",
	"mock",
	"--model",
	"mock/mock-model",
	"--extension",
	probe,
	"--extension",
	bundlePath,
];
const child = spawn(command, args, {
	cwd,
	env,
	stdio: ["pipe", "pipe", "pipe"],
});
let output = "";
child.stdout.on("data", (data) => {
	output += data;
});
child.stderr.on("data", (data) => {
	output += data;
});
let exited = false;
child.on("exit", () => {
	exited = true;
});
const deadline = Date.now() + 180000;
let inspected = false;
let inspectedNative = false;
try {
	while (!existsSync(path.join(run, "result.json"))) {
		assert(
			!existsSync(path.join(run, "error.txt")),
			existsSync(path.join(run, "error.txt"))
				? readFileSync(path.join(run, "error.txt"), "utf8")
				: "",
		);
		assert(
			!exited && Date.now() < deadline,
			`host exited or timed out: ${output.slice(-4000)}`,
		);
		if (existsSync(path.join(run, "ready.json")) && !inspected) {
			const lsof = execFileSync("lsof", ["-p", String(child.pid)], {
				encoding: "utf8",
			});
			writeFileSync(path.join(run, "lsof.txt"), lsof);
			const dbLines = lsof
				.split("\n")
				.filter((line) => /\.db(?:\W|$)/.test(line));
			assert(dbLines.length > 0, "lsof must observe actual open databases");
			assert(
				dbLines.every((line) => line.includes(run)),
				"host opened a database outside the throwaway root",
			);
			inspected = true;
		}
		if (existsSync(path.join(run, "sqlite-active")) && !inspectedNative) {
			const lsof = execFileSync("lsof", ["-p", String(child.pid)], {
				encoding: "utf8",
			});
			writeFileSync(path.join(run, "lsof-sqlite.txt"), lsof);
			const dbLines = lsof
				.split("\n")
				.filter((line) => /\.db(?:\W|$)/.test(line));
			assert(
				dbLines.some((line) => line.includes("probe.db")),
				"lsof must observe the synchronous SQLite database while the host is stalled",
			);
			assert(
				dbLines.every((line) => line.includes(run)),
				"stalled host opened a database outside the throwaway root",
			);
			inspectedNative = true;
		}
		await new Promise((resolve) => setTimeout(resolve, 500));
	}
	const result = JSON.parse(
		readFileSync(path.join(run, "result.json"), "utf8"),
	);
	assert(inspected && inspectedNative);
	assert.equal(
		result.reports.length,
		4,
		"busy, SQLite, context and re-enabled busy each need one report",
	);
	assert(
		result.reports[0].owners[0].owner.includes("host-stall-test-extension"),
	);
	assert(
		result.reports[1].owners[0].owner.includes("host-stall-test-extension"),
	);
	assert(
		result.reports[1].top_js_frames.some((frame) =>
			frame.frame.includes("deliberateSqliteCaller"),
		),
	);
	assert.equal(
		result.reports[2].owners[0].owner,
		"pkg:@cortexkit/pi-magic-context",
	);
	assert(
		result.reports[3].owners[0].owner.includes("host-stall-test-extension"),
	);
	console.log(
		JSON.stringify(
			{
				host: manifest.name,
				version: manifest.version,
				run,
				off: result.off,
				on: result.on,
				reports: result.reports.map((r) => ({
					backend: r.backend,
					window: r.window,
					sampling: r.sampling,
					owners: r.owners,
					top_js_frames: r.top_js_frames.slice(0, 2),
				})),
			},
			null,
			2,
		),
	);
} finally {
	child.kill("SIGTERM");
	server.close();
	writeFileSync(path.join(run, "host-output.txt"), output);
}
