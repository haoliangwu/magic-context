// Run from the repository root after `bun run --cwd packages/pi-plugin build`:
// PI_BIN=/path/to/pi node packages/pi-plugin/scripts/probe-dreamer-budget.cjs
// Uses only a throwaway Pi home and a localhost mock provider. The same read
// tool must reach both provider requests, but the first tool execution must be
// blocked by the child extension after the finalize marker is set.
const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const cp = require("node:child_process");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "mc-budget-probe-"));
const agentDir = path.join(root, "agent");
fs.mkdirSync(agentDir);
const guard = path.join(root, "guard");
fs.writeFileSync(guard, "");
const requests = [];
const server = http.createServer(async (req, res) => {
	let body = "";
	for await (const chunk of req) body += chunk;
	const input = JSON.parse(body);
	requests.push(input);
	const index = requests.length;
	res.writeHead(200, { "Content-Type": "text/event-stream" });
	const chunk = (delta, finish_reason = null) =>
		res.write(
			`data: ${JSON.stringify({ id: `chatcmpl-${index}`, object: "chat.completion.chunk", created: 1720000000, model: "probe-model", choices: [{ index: 0, delta, finish_reason }] })}\n\n`,
		);
	chunk({ role: "assistant" });
	if (index === 1) {
		chunk({
			tool_calls: [
				{
					index: 0,
					id: "call_probe",
					type: "function",
					function: { name: "read", arguments: '{"path":"README.md"}' },
				},
			],
		});
		chunk({}, "tool_calls");
	} else {
		chunk({ content: "<mappings></mappings>" });
		chunk({}, "stop");
	}
	res.write(
		`data: ${JSON.stringify({ id: `chatcmpl-${index}`, object: "chat.completion.chunk", created: 1720000000, model: "probe-model", choices: [], usage: { prompt_tokens: index === 1 ? 81 : 1, completion_tokens: 7, total_tokens: index === 1 ? 88 : 8 } })}\n\n`,
	);
	res.end("data: [DONE]\n\n");
});
server.listen(0, "127.0.0.1", () => {
	const port = server.address().port;
	fs.writeFileSync(
		path.join(agentDir, "models.json"),
		JSON.stringify({
			providers: {
				probe: {
					baseUrl: `http://127.0.0.1:${port}/v1`,
					api: "openai-completions",
					apiKey: "probe",
					models: [
						{
							id: "probe-model",
							name: "Probe",
							contextWindow: 100000,
							maxTokens: 4096,
							input: ["text"],
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
						},
					],
				},
			},
		}),
	);
	const cli = process.env.PI_BIN || "pi";
	const child = cp.spawn(
		cli,
		[
			"--mode",
			"rpc",
			"--no-session",
			"--model",
			"probe/probe-model",
			"--tools",
			"read",
			"--no-context-files",
			"--no-skills",
			"--no-prompt-templates",
			"--no-extensions",
			"--extension",
			path.resolve("packages/pi-plugin/dist/subagent-entry.js"),
			"--system-prompt",
			"Return XML mappings.",
		],
		{
			cwd: process.cwd(),
			env: {
				...process.env,
				HOME: root,
				XDG_CONFIG_HOME: path.join(root, "config"),
				XDG_DATA_HOME: path.join(root, "data"),
				PI_CODING_AGENT_DIR: agentDir,
				PI_OFFLINE: "1",
				MAGIC_CONTEXT_SUBAGENT_BUDGET_GUARD_FILE: guard,
			},
			stdio: ["pipe", "pipe", "pipe"],
		},
	);
	let buffer = "";
	let sent = false;
	let ended = false;
	let refused = 0;
	let verified = false;
	const timeout = setTimeout(() => {
		console.error("TIMEOUT", requests.length);
		child.kill();
		server.close();
		process.exitCode = 1;
	}, 20000);
	child.stderr.on("data", (b) => process.stderr.write(b));
	child.stdout.on("data", (b) => {
		buffer += b;
		while (buffer.includes("\n")) {
			const n = buffer.indexOf("\n");
			const line = buffer.slice(0, n);
			buffer = buffer.slice(n + 1);
			if (!line.trim()) continue;
			let ev;
			try {
				ev = JSON.parse(line);
			} catch {
				console.log("noise", line);
				continue;
			}
			console.log(
				"event",
				ev.type,
				ev.command ?? "",
				ev.message?.role ?? "",
				ev.message?.usage?.input ?? "",
				ev.type === "tool_execution_end"
					? JSON.stringify(ev.result).slice(0, 300)
					: "",
			);
			if (
				ev.type === "tool_execution_end" &&
				JSON.stringify(ev.result).includes(
					"Out of token budget: no more tool calls. Output your result now.",
				)
			)
				refused++;
			if (
				ev.type === "message_end" &&
				ev.message?.role === "assistant" &&
				!sent
			) {
				sent = true;
				fs.writeFileSync(guard, "finalize");
				child.stdin.write(
					`${JSON.stringify({
						type: "steer",
						message:
							"Out of token budget. No more tool calls. Output result now.",
						id: "final",
					})}\n`,
				);
			}
			if (ev.type === "agent_end" && !ended) {
				ended = true;
				const lsof = cp.spawnSync("lsof", ["-p", String(child.pid)], {
					encoding: "utf8",
				});
				const forbidden = lsof.stdout
					.split("\n")
					.filter((s) =>
						/\/\.config\/(opencode|cortexkit)\/|\/\.pi\/agent\/|\/\.local\/share\/(opencode|cortexkit\/magic-context)\//.test(
							s,
						),
					);
				console.log(
					"lsof PID",
					child.pid,
					"exit",
					lsof.status,
					"forbidden-open-files",
					forbidden,
				);
				const sameTools =
					requests.length > 1 &&
					requests[0].tools.length > 0 &&
					requests.every(
						(r) =>
							JSON.stringify(r.tools) === JSON.stringify(requests[0].tools),
					);
				const finalTurns = requests
					.at(-1)
					.messages.filter((m) => m.role === "user").length;
				verified =
					lsof.status === 0 &&
					forbidden.length === 0 &&
					sameTools &&
					refused === 1 &&
					finalTurns === 2;
				console.log(
					"requests",
					requests.length,
					"tools-byte-identical",
					sameTools,
					"refused",
					refused,
					"user-turns-in-final-request",
					finalTurns,
					"verified",
					verified,
				);
				child.kill();
				clearTimeout(timeout);
				server.close();
			}
		}
	});
	child.on("exit", (code) => {
		console.log("exit", code, "root", root);
		clearTimeout(timeout);
		server.close();
		if (!ended || !verified) {
			console.error("Pi real-host budget probe FAILED");
			process.exitCode = 1;
		} else console.log("Pi real-host budget probe PASSED");
		fs.rmSync(root, { recursive: true, force: true });
	});
	child.stdin.write(
		`${JSON.stringify({
			type: "prompt",
			message: "Inspect README.md and report mappings.",
			id: "initial",
		})}\n`,
	);
});
