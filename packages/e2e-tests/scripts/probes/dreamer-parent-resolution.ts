import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// Set isolation before importing any helper that resolves config or storage.
const base = join(process.env.TMPDIR ?? "/tmp", "magic-context");
mkdirSync(base, { recursive: true });
const root = realpathSync(
	mkdtempSync(join(base, "dreamer-parent-resolution-")),
);
const env: Record<string, string> = { PATH: process.env.PATH ?? "" };
for (const [key, path] of Object.entries({
	HOME: join(root, "home"),
	TMPDIR: join(root, "tmp"),
	XDG_CONFIG_HOME: join(root, "config"),
	XDG_DATA_HOME: join(root, "data"),
	XDG_CACHE_HOME: join(root, "cache"),
	XDG_STATE_HOME: join(root, "state"),
	XDG_RUNTIME_DIR: join(root, "runtime"),
	OPENCODE_CONFIG_DIR: join(root, "config", "opencode"),
	MAGIC_CONTEXT_STORAGE_DIR: join(root, "mc"),
})) {
	mkdirSync(path, { recursive: true });
	env[key] = path;
	process.env[key] = path;
}
env.OPENCODE_DB = join(root, "data", "opencode", "opencode.db");
env.MAGIC_CONTEXT_LOG_PATH = join(root, "mc", "magic-context.log");
process.env.OPENCODE_DB = env.OPENCODE_DB;
process.env.MAGIC_CONTEXT_LOG_PATH = env.MAGIC_CONTEXT_LOG_PATH;
env.OPENCODE_DISABLE_DEFAULT_PLUGINS = "true";
env.OPENCODE_DISABLE_MODELS_FETCH = "true";
const binary = process.env.MC_OC1_BINARY ?? "opencode";
const version = spawnSync(binary, ["--version"], {
	env,
	encoding: "utf8",
	windowsHide: true,
});
assert.equal(version.status, 0, version.stderr);
assert.equal(version.stdout.trim(), "1.18.30");

const { createOpencodeClient } = await import("@opencode-ai/sdk");
const { Database } = await import("../../../plugin/src/shared/sqlite");
const { initializeDatabase } = await import(
	"../../../plugin/src/features/magic-context/storage-db"
);
const { runMigrations } = await import(
	"../../../plugin/src/features/magic-context/migrations"
);
const { insertMemory, recordMemoryVerifications } = await import(
	"../../../plugin/src/features/magic-context/memory"
);
const { createDreamTaskExecutor } = await import(
	"../../../plugin/src/features/magic-context/dreamer/task-executor"
);
const { runDueTasksForProject } = await import(
	"../../../plugin/src/features/magic-context/dreamer/task-scheduler"
);
const { seedTaskScheduleState, getTaskScheduleState, writeTaskScheduleState } =
	await import(
		"../../../plugin/src/features/magic-context/dreamer/storage-task-schedule"
	);
const { flushLogger } = await import("../../../plugin/src/shared/logger");
const { getSubagentInvocations } = await import(
	"../../../plugin/src/features/magic-context/storage-subagent-invocations"
);
const { getDreamRuns } = await import(
	"../../../plugin/src/features/magic-context/dreamer/storage-dream-runs"
);

function git(directory: string, ...args: string[]): void {
	const result = spawnSync("git", ["-C", directory, ...args], {
		env,
		encoding: "utf8",
		windowsHide: true,
	});
	assert.equal(result.status, 0, result.stderr);
}
const main = join(root, "main");
const checkout = join(root, "checkout");
const parentless = join(root, "parentless");
for (const directory of [main, parentless]) {
	mkdirSync(join(directory, "src"), { recursive: true });
	writeFileSync(
		join(directory, "src", "fact.ts"),
		"export const fact = true;\n",
	);
	git(directory, "init", "-b", "main");
	git(directory, "add", "src/fact.ts");
	git(
		directory,
		"-c",
		"user.name=Mock",
		"-c",
		"user.email=mock@example.invalid",
		"commit",
		"-m",
		"fixture",
	);
}
// Distinct host project IDs require distinct root commits.
writeFileSync(join(parentless, "other.txt"), "A different project.\n");
git(parentless, "add", "other.txt");
git(
	parentless,
	"-c",
	"user.name=Mock",
	"-c",
	"user.email=mock@example.invalid",
	"commit",
	"--amend",
	"--no-edit",
);
git(main, "worktree", "add", "-b", "checkout", checkout);

let verifyId = 0;
let generations = 0;
const mock = Bun.serve({
	hostname: "127.0.0.1",
	port: 0,
	async fetch(request) {
		const body = (await request.json()) as { model: string };
		assert.equal(body.model, "mock-model");
		generations++;
		const chunk = (delta: unknown, finish: string | null, usage?: unknown) =>
			`data: ${JSON.stringify({ id: "chatcmpl-parent", object: "chat.completion.chunk", created: 1, model: body.model, choices: [{ index: 0, delta, finish_reason: finish }], ...(usage ? { usage } : {}) })}\n\n`;
		return new Response(
			chunk(
				{
					role: "assistant",
					content: `<verify><verified id="${verifyId}"/></verify>`,
				},
				null,
			) +
				chunk({}, "stop", {
					prompt_tokens: 200,
					completion_tokens: 80,
					total_tokens: 280,
				}) +
				"data: [DONE]\n\n",
			{ headers: { "content-type": "text/event-stream" } },
		);
	},
});
writeFileSync(
	join(env.OPENCODE_CONFIG_DIR, "opencode.json"),
	JSON.stringify({
		model: "mock/mock-model",
		small_model: "mock/mock-model",
		enabled_providers: ["mock"],
		autoupdate: false,
		compaction: { auto: false, prune: false },
		provider: {
			mock: {
				npm: "@ai-sdk/openai-compatible",
				options: {
					baseURL: `http://127.0.0.1:${mock.port}/v1`,
					apiKey: "mock-only",
				},
				models: {
					"mock-model": {
						name: "Mock",
						limit: { context: 100000, output: 4096 },
					},
				},
			},
		},
		agent: { "dreamer-memory-mapper": { hidden: true, mode: "subagent" } },
	}),
);

// This host treats --port 0 as its default, not an ephemeral port. Reserve a
// loopback port and verify the spawned host announces it before making requests.
const reservation = Bun.serve({
	hostname: "127.0.0.1",
	port: 0,
	fetch: () => new Response(),
});
const hostPort = reservation.port;
reservation.stop(true);
const proc = spawn(
	binary,
	["serve", "--hostname", "127.0.0.1", "--port", String(hostPort)],
	{ cwd: main, env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
);
let logs = "";
assert.ok(proc.stdout);
assert.ok(proc.stderr);
const hostPid = proc.pid;
assert.ok(hostPid);
proc.stdout.on("data", (chunk) => {
	logs += chunk;
});
proc.stderr.on("data", (chunk) => {
	logs += chunk;
});
const exited = new Promise<void>((resolve) =>
	proc.once("close", () => resolve()),
);
const db = new Database(":memory:");
initializeDatabase(db);
runMigrations(db);
const evidence: Record<string, unknown> = {
	root,
	hostVersion: version.stdout.trim(),
	hostPid: proc.pid,
};
const config = {
	task: "verify-broad" as const,
	schedule: "0 3 * * *",
	timeoutMinutes: 5,
	model: "mock/mock-model",
};
function seed(project: string): number {
	const memory = insertMemory(db, {
		projectPath: project,
		category: "ARCHITECTURE",
		content: "src/fact.ts exports fact as true.",
	});
	recordMemoryVerifications(db, memory.id, ["src/fact.ts"], 1000);
	seedTaskScheduleState(
		db,
		project,
		config.task,
		Date.now() - 1000,
		null,
		config.schedule,
	);
	return memory.id;
}
function arm(project: string): void {
	const state = getTaskScheduleState(db, project, config.task);
	assert.ok(state);
	writeTaskScheduleState(db, {
		...state,
		nextDueAt: Date.now() - 1000,
	});
}
function isolation(pid: number, name: string): void {
	const opened = spawnSync("lsof", ["-nP", "-p", String(pid)], {
		encoding: "utf8",
		windowsHide: true,
	});
	assert.equal(opened.status, 0, opened.stderr);
	const paths = opened.stdout
		.split("\n")
		.flatMap((line) => line.match(/\S+\.db(?:-wal|-shm)?(?=\s|$)/g) ?? []);
	if (name.startsWith("host"))
		assert.ok(
			paths.length > 0,
			"Host database isolation must not pass on an empty descriptor list",
		);
	assert.ok(
		paths.every((path) => path.startsWith(`${root}/`)),
		opened.stdout,
	);
	writeFileSync(join(root, `${name}-lsof.txt`), opened.stdout);
	evidence[name] = [...new Set(paths)];
}

try {
	let url = "";
	const deadline = Date.now() + 90000;
	while (Date.now() < deadline) {
		assert.equal(proc.exitCode, null, logs);
		const port = logs.match(
			/opencode server listening on https?:\/\/[^:\s]+:(\d+)/,
		)?.[1];
		if (port) {
			assert.equal(Number(port), hostPort, logs);
			url = `http://127.0.0.1:${port}`;
			break;
		}
		await Bun.sleep(50);
	}
	assert.ok(url, logs);
	const lists: string[] = [];
	const created: Array<{
		id: string;
		parentID?: string;
		directory: string;
		title: string;
	}> = [];
	const sdk = createOpencodeClient({
		baseUrl: url,
		fetch: async (request) => {
			const response = await fetch(request);
			const path = new URL(request.url);
			if (path.pathname === "/session" && request.method === "GET")
				lists.push(path.search);
			if (
				path.pathname === "/session" &&
				request.method === "POST" &&
				response.ok
			)
				created.push(await response.clone().json());
			return response;
		},
	});
	const create = async (
		directory: string,
		title: string,
		parentID?: string,
	) => {
		const result = await sdk.session.create({
			query: { directory },
			body: { title, ...(parentID ? { parentID } : {}) },
		});
		assert.ok(result.data?.id, JSON.stringify(result.error));
		return result.data;
	};
	const parent = await create(main, "ordinary parent");
	isolation(hostPid, "host-before");
	for (let i = 0; i < 100; i++)
		await create(checkout, `recent child ${i}`, parent.id);
	const oldQuery = await sdk.session.list({ query: { directory: checkout } });
	assert.equal(oldQuery.data?.length, 100);
	assert.ok(oldQuery.data?.every((session) => session.parentID));
	// Exercise the second root prefix too, not just the server-side child filter.
	for (let i = 0; i < 100; i++)
		await create(checkout, `magic-context-dream-legacy-${i}`);
	const before = created.length;
	verifyId = seed(checkout);
	const executor = createDreamTaskExecutor({
		client: sdk,
		sessionDirectory: checkout,
		openOpenCodeDb: () => null,
	});
	assert.equal(
		await runDueTasksForProject({
			db,
			projectIdentity: checkout,
			tasks: [config],
			executor,
		}),
		1,
	);
	assert.equal(
		getTaskScheduleState(db, checkout, config.task)?.lastStatus,
		"completed",
		getTaskScheduleState(db, checkout, config.task)?.lastError ?? "",
	);
	assert.equal(created.length, before + 1);
	assert.equal(created.at(-1)?.parentID, parent.id);
	assert.equal(created.at(-1)?.directory, checkout);
	assert.ok(
		(
			db
				.prepare(
					"SELECT verified_at FROM memory_verifications WHERE memory_id = ?",
				)
				.get(verifyId) as { verified_at: number }
		).verified_at > 1000,
	);
	assert.ok(
		lists.some(
			(query) =>
				query.includes("scope=project") &&
				query.includes("roots=true") &&
				query.includes("limit=200"),
		),
	);
	assert.ok(generations > 0);
	const invocations = getSubagentInvocations(db, parent.id);
	assert.equal(invocations.length, 1);
	assert.equal(invocations[0]?.status, "completed");
	assert.ok((invocations[0]?.outputTokens ?? 0) > 0);
	evidence.parented = {
		child: created.at(-1),
		parent,
		generations,
		lists: [...lists],
		oldQueryRows: oldQuery.data?.length,
		invocations,
	};
	console.log(
		"PASS: crowded sibling checkout creates a parented verify child and banks its verdict",
	);

	const negativeExecutor = createDreamTaskExecutor({
		client: sdk,
		sessionDirectory: parentless,
		openOpenCodeDb: () => null,
	});
	const absentId = seed(parentless);
	const lastRunBefore = getTaskScheduleState(
		db,
		parentless,
		config.task,
	)?.lastRunAt;
	const generationsBefore = generations;
	const childrenBefore = created.length;
	assert.equal(
		await runDueTasksForProject({
			db,
			projectIdentity: parentless,
			tasks: [config],
			executor: negativeExecutor,
		}),
		1,
	);
	const state = getTaskScheduleState(db, parentless, config.task);
	assert.ok(state);
	assert.equal(state.lastStatus, "skipped");
	assert.equal(
		state.lastError,
		"no ordinary parent session is available on this host",
	);
	assert.equal(state.retryCount, 0);
	assert.equal(state.lastRunAt, lastRunBefore);
	assert.equal(state.lastBroadRunAt, null);
	assert.ok(state.nextDueAt !== null && state.nextDueAt > Date.now());
	assert.equal(generations, generationsBefore);
	assert.equal(created.length, childrenBefore);
	const runs = getDreamRuns(db, parentless);
	assert.equal(runs.length, 1);
	assert.equal(runs[0]?.tasks_failed, 0);
	assert.equal(JSON.parse(runs[0]?.tasks_json ?? "[]")[0]?.status, "skipped");
	assert.equal(
		(
			db
				.prepare(
					"SELECT verified_at FROM memory_verifications WHERE memory_id = ?",
				)
				.get(absentId) as { verified_at: number }
		).verified_at,
		1000,
	);
	assert.equal(
		await runDueTasksForProject({
			db,
			projectIdentity: parentless,
			tasks: [config],
			executor: negativeExecutor,
		}),
		0,
	);
	evidence.parentless = {
		state,
		noNewChildren: true,
		noNewGenerations: true,
		noBatchRetries: true,
		runs,
	};
	console.log(
		"PASS: genuinely parentless project skips once without a child, provider request or retry",
	);

	const newParent = await create(parentless, "first ordinary session");
	arm(parentless);
	verifyId = absentId;
	assert.equal(
		await runDueTasksForProject({
			db,
			projectIdentity: parentless,
			tasks: [config],
			executor: negativeExecutor,
		}),
		1,
	);
	assert.equal(
		getTaskScheduleState(db, parentless, config.task)?.lastStatus,
		"completed",
	);
	assert.equal(created.at(-1)?.parentID, newParent.id);
	evidence.rediscovered = {
		parent: newParent.id,
		child: created.at(-1),
		state: getTaskScheduleState(db, parentless, config.task),
	};
	isolation(hostPid, "host-after");
	isolation(process.pid, "runner");
	console.log(
		`PASS: first ordinary session is rediscovered; OpenCode 1.18.30, 3 scenarios passed; evidence ${root}`,
	);
} finally {
	flushLogger();
	writeFileSync(join(root, "evidence.json"), JSON.stringify(evidence, null, 2));
	writeFileSync(join(root, "host.log"), logs);
	db.close();
	proc.kill("SIGTERM");
	const killTimer = setTimeout(() => proc.kill("SIGKILL"), 5000);
	await exited;
	clearTimeout(killTimer);
	mock.stop(true);
}
