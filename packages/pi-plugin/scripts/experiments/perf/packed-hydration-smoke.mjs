// Run from an isolated directory containing an installed packed Pi package.
// OMP mode uses its real module loader and registration API, not a host shim.
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { pathToFileURL } from "node:url";

const entry = process.argv[2];
assert(entry, "packed entry path required");
let handlers;
let runtime;
if (process.argv[3] === "omp") {
	const { loadExtensions } = await import(
		"@oh-my-pi/pi-coding-agent/extensibility/extensions/loader"
	);
	const loaded = await loadExtensions([entry], process.cwd());
	assert.equal(loaded.errors.length, 0, JSON.stringify(loaded.errors));
	assert.equal(loaded.extensions.length, 1);
	handlers = loaded.extensions[0].handlers;
	runtime = loaded.runtime;
	Object.assign(runtime, {
		getAllTools: () => [],
		getActiveTools: () => [],
		appendEntry: () => {},
		sendMessage: () => {},
		sendUserMessage: () => {},
	});
} else {
	handlers = new Map();
	const events = new EventEmitter();
	const api = {
		on: (name, fn) => {
			const list = handlers.get(name) ?? [];
			list.push(fn);
			handlers.set(name, list);
		},
		events: {
			on: (name, fn) => {
				events.on(name, fn);
				return () => events.off(name, fn);
			},
			emit: (name, data) => events.emit(name, data),
		},
		registerCommand: () => {},
		registerTool: (tool) => {
			structuredClone(tool.parameters);
		},
		registerShortcut: () => {},
		registerFlag: () => {},
		getFlag: () => undefined,
		getAllTools: () => [],
		getActiveTools: () => [],
		appendEntry: () => {},
		sendMessage: () => {},
		sendUserMessage: () => {},
	};
	await (await import(pathToFileURL(entry).href)).default(api);
}
assert(
	handlers.get("context")?.length,
	"extension did not register a context handler",
);
const messages = [
	{ role: "user", content: "Packed hydration proof.", timestamp: 1 },
];
let aborted = false;
const ctx = {
	cwd: process.cwd(),
	hasUI: false,
	mode: "print",
	signal: new AbortController().signal,
	ui: { notify: () => {}, setStatus: () => {}, setWidget: () => {} },
	sessionManager: {
		getSessionId: () => "packed-hydration",
		getBranch: () => [{ type: "message", id: "entry-1", message: messages[0] }],
		getLeafId: () => "entry-1",
	},
	getSystemPrompt: () => "Packed smoke system.",
	getContextUsage: () => ({ tokens: 0, percent: 0, contextWindow: 100000 }),
	model: {
		provider: "openai",
		id: "gpt-4.1",
		api: "openai-completions",
		contextWindow: 100000,
		maxTokens: 16000,
	},
	abort: () => {
		aborted = true;
	},
};
let served = messages;
for (const handler of handlers.get("context")) {
	const result = await handler({ type: "context", messages: served }, ctx);
	if (result?.messages) served = result.messages;
}
for (const handler of handlers.get("before_provider_request") ?? [])
	await handler(
		{ type: "before_provider_request", payload: { messages: served } },
		ctx,
	);
assert.equal(aborted, false, "cold packed hydration refused provider dispatch");
assert.match(JSON.stringify(served), /§1§ Packed hydration proof\./);
console.log(
	JSON.stringify({
		smoke: "packed cold hydration served",
		runtime: process.versions.bun
			? `Bun ${process.versions.bun}`
			: `Node ${process.versions.node}`,
		loader: process.argv[3] ?? "direct",
		contextHandlers: handlers.get("context").length,
		servedBytes: Buffer.byteLength(JSON.stringify(served), "utf8"),
	}),
);
for (const handler of handlers.get("session_shutdown") ?? [])
	await handler({ type: "session_shutdown" }, ctx);
process.exit(0);
