#!/usr/bin/env bun
// Throwaway measurement probe: reading OpenCode 2 session history through the service's HTTP API
// versus opening the host store directly, the way Magic Context's OpenCode 2 adapter does today.
//
// Everything runs against a private root under $TMPDIR/magic-context/oc2-api-vs-store/. The host
// is the shared pinned CLI (~/.local/share/cortexkit/e2e-bin/opencode-cli/<version>/), started as
// `opencode serve --service` so it writes its registration into the private XDG_STATE_HOME. The
// child environment is an allowlist, and the host's open files are listed with lsof and checked
// against the root before the probe finishes. No live store is opened at any point.
//
// Usage:
//   bun packages/e2e-tests/scripts/probes/oc2-api-vs-store.ts [--messages 20000] [--v1]
// Writes a JSON result next to the root and prints it. `--v1` also converts a small store written
// by the OpenCode 1.x binary on PATH (MC_E2E_OPENCODE1_CLI overrides) and measures it the same way.
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Database } from "bun:sqlite";
import { V2StoreReader } from "../../../plugin/src/v2/store-reader";
import { MockProvider } from "../../src/mock-provider/server";

const VERSION = "2.0.15";
const CLI = join(
	homedir(),
	".local/share/cortexkit/e2e-bin/opencode-cli",
	VERSION,
	"node_modules/@opencode/cli/bin/opencode.exe",
);
const REENTRANCY_PLUGIN = resolve(import.meta.dir, "oc2-reentrancy-plugin");
const RAW = new Set(["user", "synthetic", "assistant", "skill", "shell", "system"]);
const REPEATS = 5;
// The 2.0.15 import route writes every message in ONE multi-row INSERT with 7 bound parameters per
// row, so a single import fails with HTTP 500 somewhere between 8,000 and 10,000 messages
// (SQLite's bound-parameter cap). Larger sessions are imported up to this size and the rest is
// appended to the projection table while the host is stopped; see appendRows.
const IMPORT_CHUNK = 8_000;

const args = process.argv.slice(2);
const TOTAL = Number(args[args.indexOf("--messages") + 1] ?? 0) || 20_000;
const WITH_V1 = args.includes("--v1");

// ---------------------------------------------------------------------------------------------
// Isolation
// ---------------------------------------------------------------------------------------------

interface Root {
	root: string;
	env: Record<string, string>;
	cwd: string;
	db: string;
}

function makeRoot(label: string): Root {
	const base = join(tmpdir(), "magic-context", "oc2-api-vs-store");
	mkdirSync(base, { recursive: true });
	const root = realpathSync(mkdtempSync(join(base, `${label}-`)));
	const env: Record<string, string> = {
		PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
		OPENCODE_DB: "opencode2.db",
		OPENCODE_DISABLE_DEFAULT_PLUGINS: "true",
		OPENCODE_DISABLE_MODELS_FETCH: "1",
		OPENCODE_DISABLE_AUTOUPDATE: "true",
	};
	for (const key of [
		"HOME",
		"XDG_DATA_HOME",
		"XDG_CONFIG_HOME",
		"XDG_STATE_HOME",
		"XDG_RUNTIME_DIR",
		"XDG_CACHE_HOME",
		"TMPDIR",
	]) {
		env[key] = join(root, key);
		mkdirSync(env[key]!);
	}
	env.MAGIC_CONTEXT_STORAGE_DIR = join(root, "magic-context");
	mkdirSync(env.MAGIC_CONTEXT_STORAGE_DIR);
	const cwd = join(root, "work");
	mkdirSync(cwd);
	return { root, env, cwd, db: join(env.XDG_DATA_HOME!, "opencode", "opencode2.db") };
}

/** Every `.db` path the process holds, and a hard failure if any lies outside the root. */
function assertOnlyThrowawayDatabases(pid: number, root: string): string[] {
	const result = spawnSync("lsof", ["-p", String(pid), "-Fn"], { encoding: "utf8" });
	if (result.status !== 0) throw new Error(`lsof failed: ${result.stderr}`);
	const dbs = result.stdout
		.split("\n")
		.filter((line) => line.startsWith("n") && /\.db(-wal|-shm)?$/.test(line))
		.map((line) => line.slice(1));
	const real = (p: string) => (p.startsWith("/private/") ? p : `/private${p}`);
	for (const path of dbs)
		if (!real(path).startsWith(real(root)) && !path.startsWith(root))
			throw new Error(`host holds a database outside the throwaway root: ${path}`);
	const live = [
		join(homedir(), ".local/share/opencode"),
		join(homedir(), ".local/share/cortexkit/magic-context"),
		join(homedir(), ".local/state/opencode"),
	];
	for (const line of result.stdout.split("\n"))
		if (line.startsWith("n") && live.some((p) => line.slice(1).startsWith(p)))
			throw new Error(`host holds a live path: ${line.slice(1)}`);
	return [...new Set(dbs)];
}

// ---------------------------------------------------------------------------------------------
// Host
// ---------------------------------------------------------------------------------------------

interface Host {
	child: ChildProcess;
	url: string;
	auth: string;
	pid: number;
	registration: Record<string, unknown>;
	stop(): Promise<void>;
}

async function startService(fixture: Root, extraEnv: Record<string, string> = {}): Promise<Host> {
	const child = spawn(CLI, ["serve", "--service", "--hostname", "127.0.0.1", "--port", "0"], {
		cwd: fixture.cwd,
		env: { ...fixture.env, ...extraEnv },
		detached: true,
		stdio: ["ignore", "pipe", "pipe"],
	});
	let output = "";
	child.stdout?.on("data", (c) => (output += c));
	child.stderr?.on("data", (c) => (output += c));
	const registrationPath = join(fixture.env.XDG_STATE_HOME!, "opencode", "service.json");
	const deadline = Date.now() + 60_000;
	let registration: Record<string, unknown> | undefined;
	while (Date.now() < deadline) {
		if (existsSync(registrationPath)) {
			try {
				registration = JSON.parse(readFileSync(registrationPath, "utf8"));
				if (registration?.url) break;
			} catch {}
		}
		if (child.exitCode !== null) throw new Error(`host exited: ${output}`);
		await Bun.sleep(50);
	}
	if (!registration) throw new Error(`no registration written: ${output}`);
	const exited = new Promise<void>((r) => child.once("close", () => r()));
	return {
		child,
		url: String(registration.url),
		auth: `Basic ${Buffer.from(`opencode:${registration.password}`).toString("base64")}`,
		pid: Number(registration.pid),
		registration,
		stop: async () => {
			try {
				process.kill(-child.pid!, "SIGTERM");
			} catch {}
			await Promise.race([exited, Bun.sleep(5000)]);
			try {
				process.kill(-child.pid!, "SIGKILL");
			} catch {}
		},
	};
}

async function api(host: Host, path: string, init: RequestInit = {}) {
	const started = performance.now();
	const res = await fetch(`${host.url}${path}`, {
		...init,
		headers: {
			authorization: host.auth,
			...(init.body ? { "content-type": "application/json" } : {}),
			...init.headers,
		},
	});
	const text = await res.text();
	return {
		status: res.status,
		text,
		bytes: Buffer.byteLength(text),
		ms: performance.now() - started,
		json: () => JSON.parse(text),
	};
}

// ---------------------------------------------------------------------------------------------
// Synthetic session
// ---------------------------------------------------------------------------------------------

const randomID = (prefix: string) =>
	`${prefix}_${randomBytes(6).toString("hex")}${randomBytes(10).toString("base64url").slice(0, 14)}`;
const lorem = (n: number) => "lorem ipsum dolor sit amet ".repeat(Math.ceil(n / 27)).slice(0, n);

/**
 * `total` rows: user/assistant turns with some tool calls, an idle row per turn, and one completed
 * compaction at 70%. Ids are random, so id order is NOT the timeline order; any reader that sorts
 * by id instead of by position gets a different sequence.
 */
function syntheticSession(sessionID: string, directory: string, total: number) {
	const tokens = { input: 100, output: 20, reasoning: 0, cache: { read: 0, write: 0 } };
	const model = { providerID: "openai", id: "mock-model" };
	const messages: Array<Record<string, unknown>> = [];
	let t = 1_780_000_000_000;
	let turn = 0;
	const compactAt = Math.floor(total * 0.7);
	while (messages.length < total) {
		turn += 1;
		messages.push({ id: randomID("msg"), time: { created: t++ }, type: "user", text: `turn ${turn} ${lorem(200)}` });
		const content: Array<Record<string, unknown>> = [{ type: "text", text: lorem(600) }];
		if (turn % 3 === 0)
			content.push({
				type: "tool",
				id: `call_${turn}`,
				name: "read",
				state: { status: "completed", input: { path: `/tmp/f${turn}` }, content: [{ type: "text", text: lorem(1500) }] },
				time: { created: t, completed: t + 1 },
			});
		messages.push({ id: randomID("msg"), time: { created: t++, completed: t }, type: "assistant", agent: "build", model, content, finish: "stop", cost: 0, tokens });
		if (turn % 5 === 0) messages.push({ id: randomID("msg"), time: { created: t++ }, type: "idle", outcome: "succeeded" });
		if (messages.length >= compactAt && !messages.some((m) => m.type === "compaction"))
			messages.push({ id: randomID("msg"), time: { created: t++ }, type: "compaction", status: "completed", reason: "auto", summary: lorem(4000), recent: "" });
	}
	messages.length = total;
	return {
		info: { id: sessionID, projectID: "x", cost: 0, tokens, time: { created: 1_780_000_000_000, updated: t }, location: { directory } },
		messages,
		location: { directory },
	};
}

/**
 * Append messages to an imported session in the same shape the import route writes: one
 * `session_message` projection row per message, `data` holding the message minus id and type,
 * `seq` continuing the session's sequence. The import route writes no `event` rows for imported
 * messages either, so this reproduces its output exactly. Only ever called on the throwaway store,
 * with the host stopped.
 */
function appendRows(db: string, sessionID: string, messages: Array<Record<string, any>>) {
	const store = new Database(db);
	try {
		const start = (store.query("SELECT MAX(seq) AS seq FROM session_message WHERE session_id = ?").get(sessionID) as { seq: number }).seq;
		const insert = store.prepare(
			"INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?, ?)",
		);
		const now = Date.now();
		store.transaction(() => {
			messages.forEach((message, index) => {
				const { id, type, ...data } = message;
				insert.run(id, sessionID, type, start + index + 1, message.time.created, now, JSON.stringify(data));
			});
		})();
	} finally {
		store.close();
	}
}

// ---------------------------------------------------------------------------------------------
// Measurement helpers
// ---------------------------------------------------------------------------------------------

interface Sample {
	ms: number;
	bytes: number;
	requests?: number;
	rows?: number;
	extra?: Record<string, unknown>;
}

async function measure(label: string, run: () => Promise<Sample> | Sample) {
	const first = await run();
	const rest: Sample[] = [];
	for (let i = 0; i < REPEATS; i++) rest.push(await run());
	const sorted = [...rest].sort((a, b) => a.ms - b.ms);
	const median = sorted[Math.floor(sorted.length / 2)]!;
	return {
		label,
		firstMs: +first.ms.toFixed(1),
		medianMs: +median.ms.toFixed(1),
		bytes: median.bytes,
		requests: median.requests,
		rows: median.rows,
		...(median.extra ? { extra: median.extra } : {}),
	};
}

function withReader<T>(db: string, fn: (reader: V2StoreReader) => T): T {
	const reader = new V2StoreReader(db);
	try {
		return fn(reader);
	} finally {
		reader.close();
	}
}
const rowBytes = (rows: Array<{ data: unknown }>) =>
	rows.reduce((sum, row) => sum + Buffer.byteLength(JSON.stringify(row.data)), 0);

/** Walk `/message` with the largest page the route accepts, from a cursor or from one end. */
async function walk(
	host: Host,
	sessionID: string,
	options: { order?: "asc" | "desc"; cursor?: string; stop?: (rows: any[]) => boolean; type?: string } = {},
) {
	const started = performance.now();
	let cursor = options.cursor;
	let bytes = 0;
	let requests = 0;
	const rows: any[] = [];
	for (;;) {
		const query = new URLSearchParams({ limit: "200" });
		if (cursor) query.set("cursor", cursor);
		else query.set("order", options.order ?? "asc");
		if (options.type) query.set("type", options.type);
		const res = await api(host, `/api/session/${sessionID}/message?${query}`);
		requests += 1;
		bytes += res.bytes;
		if (res.status !== 200) throw new Error(`message.list ${res.status}: ${res.text}`);
		const body = res.json();
		rows.push(...body.data);
		if (body.data.length < 200 || options.stop?.(rows)) break;
		cursor = body.cursor.next;
	}
	return { rows, bytes, requests, ms: performance.now() - started };
}

/** The route's opaque cursor, built for an id we already know; see the report for why. */
const forgeCursor = (id: string, order: "asc" | "desc" = "asc") =>
	Buffer.from(JSON.stringify({ id, order, direction: "next" })).toString("base64url");

// ---------------------------------------------------------------------------------------------
// Coverage and cost against one session
// ---------------------------------------------------------------------------------------------

async function measureSession(host: Host, db: string, sessionID: string) {
	const out: Record<string, unknown> = { sessionID };

	// Ground truth from the store: every row in seq order.
	const storeRows = withReader(db, (r) => r.history(sessionID));
	const rawRows = storeRows.filter((row) => RAW.has(row.type));
	out.storeRowCount = storeRows.length;
	out.storeRawCount = rawRows.length;

	// Coverage: does an unfiltered ascending walk return the same rows in the same order?
	const fullAsc = await walk(host, sessionID, { order: "asc" });
	const apiIds = fullAsc.rows.map((m) => m.id);
	const storeIds = storeRows.map((row) => row.id);
	out.orderMatchesSeq = JSON.stringify(apiIds) === JSON.stringify(storeIds);
	out.apiRowCount = apiIds.length;
	out.idOrderDiffersFromSeq = JSON.stringify([...storeIds].sort()) !== JSON.stringify(storeIds);
	out.apiRowKeys = [...new Set(fullAsc.rows.flatMap((m) => Object.keys(m)))].sort();
	// Shape parity: the API object minus the envelope fields should be the stored payload.
	let shapeMismatch = 0;
	const byId = new Map(fullAsc.rows.map((m) => [m.id, m]));
	for (const row of storeRows) {
		const apiRow = { ...byId.get(row.id) };
		delete apiRow.id;
		delete apiRow.type;
		const stored = { ...(row.data as Record<string, unknown>) };
		delete stored.id;
		delete stored.type;
		const norm = (v: unknown) => JSON.stringify(v, (_k, x) => (x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort()) : x));
		if (norm(apiRow) !== norm(stored)) shapeMismatch += 1;
	}
	out.shapeMismatchRows = shapeMismatch;
	const ctx = await api(host, `/api/session/${sessionID}/context`);
	const ctxRows = ctx.json().data as any[];
	const cut = withReader(db, (r) => r.latestCompaction(sessionID));
	out.contextRoute = {
		rows: ctxRows.length,
		bytes: ctx.bytes,
		firstType: ctxRows[0]?.type,
		startsAtCompaction: cut ? ctxRows[0]?.id === cut.id : null,
		rowsBeforeCompactionInStore: cut ? storeRows.findIndex((row) => row.id === cut.id) : null,
	};
	const compactions = await api(host, `/api/session/${sessionID}/message?type=compaction&order=desc&limit=5`);
	out.compactionFilter = { status: compactions.status, rows: compactions.json().data.length };
	const idleFilter = await api(host, `/api/session/${sessionID}/message?type=idle&order=desc&limit=5`);
	out.idleFilter = { status: idleFilter.status };
	const tooBig = await api(host, `/api/session/${sessionID}/message?order=asc&limit=201`);
	out.limit201 = { status: tooBig.status, body: tooBig.text.slice(0, 120) };
	const defaultPage = await api(host, `/api/session/${sessionID}/message?order=asc`);
	out.defaultPageRows = defaultPage.json().data.length;
	const mixed = await api(host, `/api/session/${sessionID}/message?order=asc&limit=5&cursor=${forgeCursor(storeIds[0]!)}`);
	out.cursorWithOrder = { status: mixed.status };

	const N = rawRows.length;
	const results: unknown[] = [];

	// Full count.
	results.push(
		await measure("store: full raw count (messageCount)", () => {
			const started = performance.now();
			const count = withReader(db, (r) => r.messageCount(sessionID));
			return { ms: performance.now() - started, bytes: 0, rows: count };
		}),
	);
	results.push(
		await measure("api: full raw count (walk every page, limit 200)", async () => {
			const w = await walk(host, sessionID, { order: "asc" });
			return { ms: w.ms, bytes: w.bytes, requests: w.requests, rows: w.rows.filter((m) => RAW.has(m.type)).length };
		}),
	);

	// Cold first pass: every raw message, the way the indexer and a first historian pass read.
	results.push(
		await measure("store: cold first pass (count + all raw rows, pages of 100)", () => {
			const started = performance.now();
			let bytes = 0;
			let rows = 0;
			withReader(db, (r) => r.messageCount(sessionID));
			for (let after = 0; after < N; after += 100) {
				const page = withReader(db, (r) => r.messagePage(sessionID, after, 100, N));
				bytes += rowBytes(page);
				rows += page.length;
			}
			return { ms: performance.now() - started, bytes, rows };
		}),
	);
	results.push(
		await measure("api: cold first pass (walk every page, limit 200)", async () => {
			const w = await walk(host, sessionID, { order: "asc" });
			return { ms: w.ms, bytes: w.bytes, requests: w.requests, rows: w.rows.length };
		}),
	);

	// Steady pass: two new raw rows since the last pass.
	const knownLast = rawRows[N - 3]!.id;
	results.push(
		await measure("store: steady pass (count + tail page after known ordinal)", () => {
			const started = performance.now();
			const count = withReader(db, (r) => r.messageCount(sessionID));
			const page = withReader(db, (r) => r.messagePage(sessionID, count - 2, 100, count));
			return { ms: performance.now() - started, bytes: rowBytes(page), rows: page.length };
		}),
	);
	results.push(
		await measure("api: steady pass (desc page until the known last id)", async () => {
			const w = await walk(host, sessionID, { order: "desc", stop: (rows) => rows.some((m) => m.id === knownLast) });
			const idx = w.rows.findIndex((m) => m.id === knownLast);
			return { ms: w.ms, bytes: w.bytes, requests: w.requests, rows: w.rows.slice(0, idx).filter((m) => RAW.has(m.type)).length };
		}),
	);
	results.push(
		await measure("api: steady pass (desc, limit 10, one request)", async () => {
			const res = await api(host, `/api/session/${sessionID}/message?order=desc&limit=10`);
			return { ms: res.ms, bytes: res.bytes, requests: 1, rows: res.json().data.length };
		}),
	);

	// Historian chunk: raw ordinals 5001..5500.
	const from = Math.min(5000, Math.floor(N / 4));
	const anchor = rawRows[from - 1]!.id;
	results.push(
		await measure(`store: historian chunk (raw ordinals ${from + 1}..${from + 500}, pages of 100)`, () => {
			const started = performance.now();
			let bytes = 0;
			let rows = 0;
			for (let after = from; after < from + 500; after += 100) {
				const page = withReader(db, (r) => r.messagePage(sessionID, after, 100, from + 500));
				bytes += rowBytes(page);
				rows += page.length;
			}
			return { ms: performance.now() - started, bytes, rows };
		}),
	);
	results.push(
		await measure("api: historian chunk resumed from a known anchor id (forged cursor)", async () => {
			const w = await walk(host, sessionID, { cursor: forgeCursor(anchor), stop: (rows) => rows.filter((m) => RAW.has(m.type)).length >= 500 });
			return { ms: w.ms, bytes: w.bytes, requests: w.requests, rows: w.rows.filter((m) => RAW.has(m.type)).slice(0, 500).length };
		}),
	);
	results.push(
		await measure("api: historian chunk with no anchor (walk from the start)", async () => {
			const w = await walk(host, sessionID, { order: "asc", stop: (rows) => rows.filter((m) => RAW.has(m.type)).length >= from + 500 });
			return { ms: w.ms, bytes: w.bytes, requests: w.requests, rows: 500 };
		}),
	);

	// Lookup by id, with and without the ordinal the adapter also needs.
	const target = rawRows[Math.floor(N / 2)]!.id;
	results.push(
		await measure("store: lookup by id + its ordinal", () => {
			const started = performance.now();
			const [row, ordinal] = withReader(db, (r) => [r.messageById(sessionID, target), r.messageOrdinalById(sessionID, target)] as const);
			return { ms: performance.now() - started, bytes: row ? Buffer.byteLength(JSON.stringify(row.data)) : 0, rows: 1, extra: { ordinal } };
		}),
	);
	results.push(
		await measure("api: lookup by id (message.get, no ordinal)", async () => {
			const res = await api(host, `/api/session/${sessionID}/message/${target}`);
			return { ms: res.ms, bytes: res.bytes, requests: 1, rows: res.status === 200 ? 1 : 0 };
		}),
	);
	results.push(
		await measure("api: session.context (post-compaction window)", async () => {
			const res = await api(host, `/api/session/${sessionID}/context`);
			return { ms: res.ms, bytes: res.bytes, requests: 1, rows: res.json().data.length };
		}),
	);
	results.push(
		await measure("api: latest completed compaction (type=compaction desc limit 5)", async () => {
			const res = await api(host, `/api/session/${sessionID}/message?type=compaction&order=desc&limit=5`);
			return { ms: res.ms, bytes: res.bytes, requests: 1, rows: res.json().data.length };
		}),
	);
	results.push(
		await measure("store: latest completed compaction", () => {
			const started = performance.now();
			const row = withReader(db, (r) => r.latestCompaction(sessionID));
			return { ms: performance.now() - started, bytes: row ? Buffer.byteLength(JSON.stringify(row.data)) : 0, rows: row ? 1 : 0 };
		}),
	);
	out.measurements = results;
	return out;
}

// ---------------------------------------------------------------------------------------------
// Re-entrancy: the probe plugin calls the service's own API from inside the context hook
// ---------------------------------------------------------------------------------------------

async function reentrancy(host: Host, fixture: Root, probeOut: string) {
	const created = await api(host, "/api/session", {
		method: "POST",
		body: JSON.stringify({ location: { directory: fixture.cwd } }),
	});
	const sessionID = created.json().data.id as string;
	const started = performance.now();
	const prompt = await api(host, `/api/session/${sessionID}/prompt`, {
		method: "POST",
		body: JSON.stringify({ text: "Reply briefly." }),
	});
	const wait = await Promise.race([
		api(host, `/api/experimental/session/${sessionID}/wait`, { method: "POST" }),
		Bun.sleep(120_000).then(() => ({ status: -1, text: "wait timed out after 120s" })),
	]);
	const elapsed = performance.now() - started;
	const records = existsSync(probeOut)
		? readFileSync(probeOut, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l))
		: [];
	const messages = await api(host, `/api/session/${sessionID}/message?order=asc&limit=20`);
	return {
		sessionID,
		promptStatus: prompt.status,
		waitStatus: wait.status,
		promptToIdleMs: +elapsed.toFixed(1),
		finalRows: messages.json().data.map((m: any) => `${m.type}${m.outcome ? `:${m.outcome}` : ""}`),
		hookRecords: records.map((r: any) => ({
			...r,
			calls: r.calls.map((c: any) => ({ ...c, text: undefined })),
		})),
	};
}

// ---------------------------------------------------------------------------------------------
// Registration check for a plain `opencode serve`
// ---------------------------------------------------------------------------------------------

async function plainServeRegistration() {
	const fixture = makeRoot("plain-serve");
	const child = spawn(CLI, ["serve", "--hostname", "127.0.0.1", "--port", "0"], {
		cwd: fixture.cwd,
		env: fixture.env,
		detached: true,
		stdio: ["ignore", "pipe", "pipe"],
	});
	let output = "";
	child.stdout?.on("data", (c) => (output += c));
	const deadline = Date.now() + 30_000;
	while (!/server listening on/.test(output) && Date.now() < deadline) await Bun.sleep(50);
	await Bun.sleep(500);
	const stateDir = join(fixture.env.XDG_STATE_HOME!, "opencode");
	const files = existsSync(stateDir) ? spawnSync("ls", [stateDir], { encoding: "utf8" }).stdout.trim() : "";
	const dbs = child.pid ? assertOnlyThrowawayDatabases(child.pid, fixture.root) : [];
	try {
		process.kill(-child.pid!, "SIGKILL");
	} catch {}
	return {
		listening: /server listening on/.test(output),
		printsPassword: /server password/.test(output),
		stateDirEntries: files,
		dbs,
	};
}

// ---------------------------------------------------------------------------------------------
// Optional: a store written by OpenCode 1.x, then converted by the 2.x host
// ---------------------------------------------------------------------------------------------

async function convertedV1(count: number) {
	const cli1 = process.env.MC_E2E_OPENCODE1_CLI ?? Bun.which("opencode");
	if (!cli1) return { skipped: "no OpenCode 1.x binary" };
	const version = spawnSync(cli1, ["--version"], { encoding: "utf8" }).stdout.trim();
	if (!/^1\./.test(version)) return { skipped: `binary on PATH is ${version}, not 1.x` };
	const fixture = makeRoot("v1-converted");
	const child = spawn(cli1, ["serve", "--hostname", "127.0.0.1", "--port", "0"], {
		cwd: fixture.cwd,
		env: { ...fixture.env, OPENCODE_DISABLE_PROJECT_CONFIG: "true" },
		detached: true,
		stdio: ["ignore", "pipe", "pipe"],
	});
	let output = "";
	child.stdout?.on("data", (c) => (output += c));
	child.stderr?.on("data", (c) => (output += c));
	const deadline = Date.now() + 60_000;
	let url: string | undefined;
	while (!url && Date.now() < deadline) {
		url = output.match(/listening on (http:\/\/\S+)/)?.[1];
		await Bun.sleep(50);
	}
	if (!url) {
		try {
			process.kill(-child.pid!, "SIGKILL");
		} catch {}
		return { skipped: `1.x host did not start: ${output.slice(0, 400)}` };
	}
	const v1Dbs = assertOnlyThrowawayDatabases(child.pid!, fixture.root);
	const q = `directory=${encodeURIComponent(fixture.cwd)}`;
	const session = await (await fetch(`${url}/session?${q}`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).json();
	const started = performance.now();
	for (let i = 0; i < count; i++) {
		const res = await fetch(`${url}/session/${session.id}/message?${q}`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ noReply: true, parts: [{ type: "text", text: `v1 message ${i} ${lorem(300)}` }] }),
		});
		if (!res.ok) {
			try {
				process.kill(-child.pid!, "SIGKILL");
			} catch {}
			return { skipped: `1.x message write failed: ${res.status} ${await res.text()}` };
		}
		await res.arrayBuffer();
	}
	const writeMs = performance.now() - started;
	try {
		process.kill(-child.pid!, "SIGTERM");
	} catch {}
	await Bun.sleep(1500);
	try {
		process.kill(-child.pid!, "SIGKILL");
	} catch {}
	const host = await startService(fixture);
	try {
		// Conversion runs at boot; wait until the API answers for the converted session.
		const until = Date.now() + 120_000;
		let migration = "";
		while (Date.now() < until) {
			migration = (await api(host, "/api/experimental/migration/v1")).text;
			if (/completed|error/.test(migration)) break;
			await Bun.sleep(200);
		}
		const tables = spawnSync("sqlite3", ["-readonly", fixture.db, "select name from sqlite_master where type='table' order by name"], { encoding: "utf8" }).stdout.trim().split("\n");
		const dbs = assertOnlyThrowawayDatabases(host.pid, fixture.root);
		let storeReader: string;
		try {
			withReader(fixture.db, (r) => r.messageCount(session.id));
			storeReader = "opened";
		} catch (error) {
			storeReader = `refused: ${String(error).slice(0, 200)}`;
		}
		const listed = await walk(host, session.id, { order: "asc" });
		return {
			v1Version: version,
			v1Dbs,
			v1Messages: count,
			v1WriteMs: +writeMs.toFixed(0),
			migration,
			v1TablesStillPresent: ["message", "part"].every((t) => tables.includes(t)),
			hasSessionV2: tables.includes("session_v2"),
			storeReader,
			apiRows: listed.rows.length,
			apiTypes: [...new Set(listed.rows.map((m) => m.type))],
			dbs,
			measured: storeReader === "opened" ? await measureSession(host, fixture.db, session.id) : undefined,
		};
	} finally {
		await host.stop();
	}
}

// ---------------------------------------------------------------------------------------------

async function main() {
	if (!existsSync(CLI)) throw new Error(`shared OpenCode ${VERSION} CLI not installed at ${CLI}`);
	const fixture = makeRoot("main");
	const probeOut = join(fixture.root, "reentrancy.jsonl");
	const bigSession = `ses_0000000000001${randomBytes(7).toString("hex").slice(0, 13)}`;
	const mock = new MockProvider();
	const provider = await mock.start();
	mock.setDefault({ text: "fixture reply", usage: { input_tokens: 100, output_tokens: 10 } });
	writeFileSync(
		join(fixture.cwd, "opencode.json"),
		JSON.stringify({
			plugins: [REENTRANCY_PLUGIN],
			model: "openai/mock-model",
			compaction: { auto: false },
			providers: {
				openai: {
					settings: { baseURL: provider.baseURL, apiKey: "mock-key" },
					models: { "mock-model": { name: "mock-model", limit: { context: 200_000, output: 8192 } } },
				},
			},
		}),
	);
	const result: Record<string, unknown> = { version: VERSION, root: fixture.root, totalMessages: TOTAL };
	const hostEnv = { MC_PROBE_OUT: probeOut, MC_PROBE_BIG_SESSION: bigSession };
	let host = await startService(fixture, hostEnv);
	try {
		const synthetic = syntheticSession(bigSession, fixture.cwd, TOTAL);
		const head = { ...synthetic, messages: synthetic.messages.slice(0, IMPORT_CHUNK) };
		const body = JSON.stringify(head);
		const imported = await api(host, "/api/experimental/session/import", { method: "POST", body });
		result.import = { status: imported.status, messages: head.messages.length, requestBytes: Buffer.byteLength(body), ms: +imported.ms.toFixed(0) };
		if (imported.status !== 200) throw new Error(`import failed: ${imported.text.slice(0, 400)}`);
		if (synthetic.messages.length > IMPORT_CHUNK) {
			await host.stop();
			appendRows(fixture.db, bigSession, synthetic.messages.slice(IMPORT_CHUNK));
			result.appendedRows = synthetic.messages.length - IMPORT_CHUNK;
			host = await startService(fixture, hostEnv);
		}
		result.registration = { ...host.registration, password: "<redacted>" };
		result.registrationPidIsHost = host.pid === host.child.pid;
		result.dbSizeBytes = Bun.file(fixture.db).size + (existsSync(`${fixture.db}-wal`) ? Bun.file(`${fixture.db}-wal`).size : 0);

		result.session = await measureSession(host, fixture.db, bigSession);
		result.reentrancy = await reentrancy(host, fixture, probeOut);
		result.openDatabases = assertOnlyThrowawayDatabases(host.pid, fixture.root);
	} finally {
		await host.stop();
		await mock.stop();
	}
	result.plainServe = await plainServeRegistration();
	if (WITH_V1) result.v1Converted = await convertedV1(Number(process.env.MC_PROBE_V1_MESSAGES ?? 1000));
	const outPath = join(fixture.root, "result.json");
	writeFileSync(outPath, `${JSON.stringify(result, null, 2)}\n`);
	console.log(JSON.stringify(result, null, 2));
	console.error(`result: ${outPath}`);
}

await main();
