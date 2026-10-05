import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { OpenCode } from "@opencode/client";

const root = join(process.env.TMPDIR ?? "/tmp", "magic-context", "issue-587");
const probeHome = join(root, "probe-home");
for (const [name, directory] of Object.entries({
	HOME: probeHome,
	XDG_CONFIG_HOME: join(probeHome, "config"),
	XDG_DATA_HOME: join(probeHome, "data"),
	XDG_CACHE_HOME: join(probeHome, "cache"),
	XDG_STATE_HOME: join(probeHome, "state"),
	XDG_RUNTIME_DIR: join(probeHome, "runtime"),
	TMPDIR: join(probeHome, "tmp"),
})) {
	mkdirSync(directory, { recursive: true });
	process.env[name] = directory;
}
process.env.MAGIC_CONTEXT_STORAGE_DIR = join(root, "probe-mc");
process.env.MAGIC_CONTEXT_LOG_PATH = join(
	root,
	"probe-mc",
	"magic-context.log",
);
const { createOpencodeClient } = await import("@opencode-ai/sdk");
const { createChildSessionWithFence } = await import(
	"../../../plugin/src/hooks/magic-context/child-session-spawn"
);
const { promptAsyncAndWaitForIdle, recordPromptSessionError } = await import(
	"../../../plugin/src/shared/prompt-async-transport"
);
const { mapMemories, MAP_BATCH_FLOOR_MS } = await import(
	"../../../plugin/src/features/magic-context/dreamer/map-memories"
);
const { Database } = await import("../../../plugin/src/shared/sqlite");
const { initializeDatabase } = await import(
	"../../../plugin/src/features/magic-context/storage-db"
);
const { runMigrations } = await import(
	"../../../plugin/src/features/magic-context/migrations"
);
const { acquireLease } = await import(
	"../../../plugin/src/features/magic-context/dreamer/lease"
);
const { getSubagentInvocations } = await import(
	"../../../plugin/src/features/magic-context/storage-subagent-invocations"
);
const { flushLogger, getLogFilePath } = await import(
	"../../../plugin/src/shared/logger"
);
assert.ok(getLogFilePath().startsWith(root));
const unsupportedModelMessage =
	"The supported API model names are deepseek-flash, deepseek-v4-pro, but you passed deepseek-v4-flash";
const evidence: unknown[] = [];
for (const version of ["v1", "v2"]) {
	const home = mkdtempSync(join(root, `${version}-`));
	const work = join(home, "work");
	mkdirSync(work, { recursive: true });
	const env = {
		PATH: process.env.PATH,
		TMPDIR: join(home, "tmp"),
		OPENCODE_DISABLE_MODELS_FETCH: "true",
		HOME: home,
		XDG_CONFIG_HOME: join(home, "config"),
		XDG_DATA_HOME: join(home, "data"),
		XDG_CACHE_HOME: join(home, "cache"),
		XDG_STATE_HOME: join(home, "state"),
		XDG_RUNTIME_DIR: join(home, "runtime"),
		MAGIC_CONTEXT_STORAGE_DIR: join(home, "mc"),
		OPENCODE_DISABLE_DEFAULT_PLUGINS: "true",
		OPENCODE_CONFIG_DIR: join(home, "config", "opencode"),
		OPENCODE_DB: version === "v2" ? "opencode2.db" : "opencode.db",
	};
	for (const value of [
		env.OPENCODE_CONFIG_DIR,
		env.TMPDIR,
		env.XDG_RUNTIME_DIR,
	])
		mkdirSync(value, { recursive: true });
	let mode = "text";
	let requests = 0;
	const mock = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(req) {
			const body = (await req.json()) as Record<string, unknown>;
			requests++;
			if (mode === "hang") await Bun.sleep(1000);
			if (mode === "deepseek-invalid-model") {
				assert.equal(body.model, "deepseek-v4-flash");
				return Response.json(
					{
						error: {
							message: unsupportedModelMessage,
							type: "invalid_request_error",
						},
					},
					{ status: 400 },
				);
			}
			if (mode === "error")
				return Response.json(
					{
						error: {
							message: "mock provider failure",
							type: "invalid_request_error",
						},
					},
					{ status: 400 },
				);
			const delta =
				mode === "reasoning"
					? { reasoning_content: "private reasoning", content: "" }
					: mode === "empty"
						? { content: "" }
						: mode === "tool"
							? {
									tool_calls: [
										{
											index: 0,
											id: "call_587",
											type: "function",
											function: { name: "missing_tool", arguments: "{}" },
										},
									],
								}
							: { content: "final answer" };
			const reason = mode === "tool" ? "tool_calls" : "stop";
			if (mode === "tool") mode = "empty";
			const chunk = (d: unknown, finish: string | null) =>
				`data: ${JSON.stringify({ id: "chatcmpl-587", object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: body.model, choices: [{ index: 0, delta: d, finish_reason: finish }] })}\n\n`;
			return new Response(
				chunk({ role: "assistant", ...delta }, null) +
					chunk({}, reason) +
					"data: [DONE]\n\n",
				{ headers: { "content-type": "text/event-stream" } },
			);
		},
	});
	writeFileSync(
		join(env.OPENCODE_CONFIG_DIR, "opencode.json"),
		JSON.stringify({
			model: "mock/mock-model",
			provider: {
				mock: {
					npm: "@ai-sdk/openai-compatible",
					name: "Mock",
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
			...(version === "v1"
				? {
						agent: {
							dreamer: { hidden: true, mode: "subagent" },
							"dreamer-memory-mapper": { hidden: true, mode: "subagent" },
						},
					}
				: {}),
		}),
	);
	if (version === "v1") {
		const configPath = join(env.OPENCODE_CONFIG_DIR, "opencode.json");
		const config = await Bun.file(configPath).json();
		config.provider.mock.models["deepseek-v4-flash"] = {
			name: "Rejected model fixture",
			limit: { context: 100000, output: 4096 },
		};
		writeFileSync(configPath, JSON.stringify(config));
	}
	if (version === "v2")
		writeFileSync(
			join(work, "opencode.json"),
			JSON.stringify({
				model: "deepseek/mock-model",
				providers: {
					deepseek: {
						settings: {
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
			}),
		);
	const cli = join(
		root,
		`install-${version}`,
		"node_modules",
		".bin",
		"opencode",
	);
	const reservation = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch: () => new Response(),
	});
	const port = reservation.port;
	reservation.stop(true);
	let logs = "";
	const proc = spawn(cli, ["serve", "--port", String(port)], {
		cwd: work,
		env,
		stdio: ["ignore", "pipe", "pipe"],
	});
	proc.stdout!.on("data", (x) => (logs += x));
	proc.stderr!.on("data", (x) => (logs += x));
	let base = "";
	const api = async (path: string, body?: unknown) => {
		if (version === "v2") {
			const client = OpenCode.make({
				baseUrl: base,
				headers: {
					authorization: `Basic ${btoa(`opencode:${logs.match(/server password (\S+)/)?.[1] ?? ""}`)}`,
				},
			});
			if (path === "/global/health") return client.server.info();
			if (path === "/session" && body)
				return client.session.create({
					...(body as any),
					model: { providerID: "deepseek", id: "mock-model" },
				});
			if (path.startsWith("/session?"))
				return client.session.list({ directory: work, parentID: null });
			const id = path.split("/")[2];
			if (path.endsWith("/prompt")) {
				await client.session.prompt({
					sessionID: id,
					text: (body as any).text,
				});
				await client.session.wait({ sessionID: id });
				return client.session.get({ sessionID: id });
			}
			if (path.endsWith("/message"))
				return client.session.context({ sessionID: id });
		}
		const res = await fetch(base + path, {
			...(body === undefined
				? {}
				: {
						method: "POST",
						body: JSON.stringify(body),
						headers: { "content-type": "application/json" },
					}),
		});
		const text = await res.text();
		try {
			return JSON.parse(text);
		} catch {
			return { status: res.status, text };
		}
	};
	try {
		let ready = false;
		for (let i = 0; i < 120; i++) {
			if (proc.exitCode !== null) throw new Error(logs);
			base =
				logs.match(/https?:\/\/(?:127\.0\.0\.1|localhost):[1-9]\d*/)?.[0] ?? "";
			if (base && new URL(base).port !== String(port))
				throw new Error("Host announced an unexpected port");
			if (!base) {
				await Bun.sleep(250);
				continue;
			}
			try {
				await api("/global/health");
				ready = true;
				break;
			} catch {}
			await Bun.sleep(250);
		}
		if (!ready) throw new Error(logs);
		const events: string[] = [];
		let eventBuffer = "";
		const consumeV1Events = (chunk: Uint8Array) => {
			const text = new TextDecoder().decode(chunk);
			events.push(text);
			eventBuffer += text;
			const frames = eventBuffer.split("\n\n");
			eventBuffer = frames.pop() ?? "";
			for (const frame of frames) {
				const data = frame
					.split("\n")
					.find((line) => line.startsWith("data: "));
				if (!data) continue;
				const event = JSON.parse(data.slice(6));
				if (event.type === "session.error")
					recordPromptSessionError(
						event.properties.sessionID,
						event.properties.error,
					);
			}
		};
		const controller = new AbortController();
		const v2 = OpenCode.make({
			baseUrl: base,
			headers: {
				authorization: `Basic ${btoa(`opencode:${logs.match(/server password (\S+)/)?.[1] ?? ""}`)}`,
			},
		});
		const stream =
			version === "v1"
				? fetch(base + "/event", { signal: controller.signal })
						.then(async (res) => {
							for await (const chunk of res.body!) consumeV1Events(chunk);
						})
						.catch(() => {})
				: (async () => {
						for await (const event of v2.event.subscribe({
							signal: controller.signal,
						}))
							events.push(JSON.stringify(event));
					})().catch(() => {});
		const parent = await api(
			"/session",
			version === "v1"
				? { title: "ordinary parent" }
				: {
						title: "ordinary parent",
						agent: "build",
						model: { providerID: "mock", id: "mock-model" },
						location: { directory: work },
					},
		);
		const sdk = createOpencodeClient({ baseUrl: base });
		const child =
			version === "v1"
				? (
						(await createChildSessionWithFence({
							client: sdk as never,
							db: null,
							parentSessionId: parent.id,
							title: "magic-context-dream-map-memories",
							directory: work,
						})) as { data: { id: string } }
					).data
				: await api("/session", {
						title: "magic-context-dreamer",
						agent: "build",
						model: { providerID: "deepseek", id: "mock-model" },
						location: { directory: work },
						parentID: parent.id,
						metadata: { magic_context: "hidden-run", role: "dreamer" },
					});
		const roots = await api(
			version === "v1" ? "/session?roots=true" : "/session?parentID=null",
		);
		assert.equal(
			version === "v1"
				? roots.some((s: any) => s.id === child.id)
				: roots.data.some((s: any) => s.id === child.id),
			version === "v2",
		);
		assert.equal(child.parentID, version === "v1" ? parent.id : undefined);
		evidence.push({ version, parent, child, roots });
		for (const scenario of ["text", "reasoning", "empty", "tool", "error"]) {
			mode = scenario;
			const start = Date.now();
			const response = await api(
				`/session/${child.id}/${version === "v1" ? "message" : "prompt"}`,
				version === "v1"
					? {
							agent: "dreamer",
							model: { providerID: "mock", modelID: "mock-model" },
							parts: [{ type: "text", text: scenario }],
						}
					: { text: scenario },
			);
			evidence.push({
				version,
				scenario,
				elapsed: Date.now() - start,
				response,
				messages: await api(`/session/${child.id}/message`),
			});
		}
		if (version === "v1") {
			mode = "deepseek-invalid-model";
			const db = new Database(":memory:");
			initializeDatabase(db);
			runMigrations(db);
			db.prepare(
				"INSERT INTO memories(id, project_path, category, content, normalized_hash, importance, first_seen_at, created_at, updated_at, last_seen_at) VALUES (1, ?, 'PROJECT_RULES', 'The fixture keeps its mapping in src/fact.ts.', 'fixture-587', 5, ?, ?, ?, ?)",
			).run(work, Date.now(), Date.now(), Date.now(), Date.now());
			acquireLease(db, "probe-holder", "probe-map");
			flushLogger();
			const logBaseline = existsSync(getLogFilePath())
				? (await Bun.file(getLogFilePath()).text()).length
				: 0;
			const start = Date.now();
			const result = await mapMemories({
				db,
				client: sdk as never,
				parentSessionId: parent.id,
				sessionDirectory: work,
				projectIdentity: work,
				holderId: "probe-holder",
				leaseKey: "probe-map",
				deadline: Date.now() + MAP_BATCH_FLOOR_MS + 60000,
				model: "mock/deepseek-v4-flash",
			});
			const invocations = getSubagentInvocations(db, parent.id);
			assert.ok(
				invocations.some(
					(row) =>
						row.error?.includes(unsupportedModelMessage) &&
						row.error.includes("status=400"),
				),
			);
			assert.ok(
				invocations.every((row) => !row.error?.includes("returned no output")),
			);
			flushLogger();
			const log = (await Bun.file(getLogFilePath()).text()).slice(logBaseline);
			assert.ok(
				log.includes(unsupportedModelMessage) && log.includes("status=400"),
			);
			assert.deepEqual(
				(await api("/session?roots=true")).map((s: any) => s.id),
				[parent.id],
			);
			evidence.push({
				version,
				scenario: "deepseek-invalid-model-map-memories",
				elapsed: Date.now() - start,
				result,
				invocations,
				logPath: getLogFilePath(),
			});
			db.close();
		}
		mode = "hang";
		const pending = api(
			`/session/${child.id}/${version === "v1" ? "message" : "prompt"}`,
			version === "v1"
				? {
						agent: "dreamer",
						model: { providerID: "mock", modelID: "mock-model" },
						parts: [{ type: "text", text: "abort mid-provider" }],
					}
				: { text: "abort mid-provider" },
		);
		await Bun.sleep(500);
		if (version === "v1") await sdk.session.abort({ path: { id: child.id } });
		else await v2.session.interrupt({ sessionID: child.id });
		await pending;
		evidence.push({
			version,
			scenario: "abort",
			messages: await api(`/session/${child.id}/message`),
		});
		if (version === "v1") {
			const start = Date.now();
			try {
				await promptAsyncAndWaitForIdle(sdk, {
					path: { id: child.id },
					query: { directory: work },
					body: {
						agent: "dreamer",
						model: { providerID: "missing-provider", modelID: "missing-model" },
						parts: [{ type: "text", text: "rejected before assistant" }],
					},
				});
			} catch (error) {
				evidence.push({
					version,
					scenario: "async-pre-assistant-rejection",
					elapsed: Date.now() - start,
					error: String(error),
				});
			}
		}
		await Bun.sleep(100);
		const lsof = spawnSync("lsof", ["-p", String(proc.pid)], {
			encoding: "utf8",
		}).stdout;
		const databaseDescriptors = lsof
			.split("\n")
			.filter((line) => /\.db(?:-wal|-shm)?$/.test(line));
		assert.ok(databaseDescriptors.length > 0);
		assert.ok(databaseDescriptors.every((line) => line.includes(home)));
		assert.ok(
			events
				.join("")
				.includes(
					version === "v1" ? "session.error" : "session.execution.failed",
				),
		);
		evidence.push({ version, requests, events: events.join(""), lsof });
		controller.abort();
		await stream;
	} finally {
		const exited = new Promise<void>((resolve) =>
			proc.once("exit", () => resolve()),
		);
		if (proc.exitCode === null) {
			proc.kill("SIGTERM");
			await Promise.race([exited, Bun.sleep(2000)]);
			if (proc.exitCode === null) proc.kill("SIGKILL");
			await exited;
		}
		mock.stop(true);
		writeFileSync(join(root, `${version}-host.log`), logs);
		writeFileSync(
			join(root, "evidence.json"),
			JSON.stringify(evidence, null, 2),
		);
	}
}
const probeLsof = spawnSync("lsof", ["-p", String(process.pid)], {
	encoding: "utf8",
}).stdout;
assert.ok(
	probeLsof
		.split("\n")
		.filter((line) => /\.db(?:-wal|-shm)?$/.test(line))
		.every((line) => line.includes(root)),
);
evidence.push({ probeLsof });
writeFileSync(join(root, "evidence.json"), JSON.stringify(evidence, null, 2));
console.log(
	JSON.stringify(
		evidence.map((x: any) => ({
			version: x.version,
			scenario: x.scenario,
			elapsed: x.elapsed,
			child: x.child,
			roots: x.roots,
			requests: x.requests,
			response: x.response,
		})),
		null,
		2,
	),
);
