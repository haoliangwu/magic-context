/// <reference types="bun-types" />

import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createOpencodeClient } from "@opencode-ai/sdk";
import { PiSubagentRunner } from "../../pi-plugin/src/subagent-runner";
import { MockProvider } from "../src/mock-provider/server";
import { createIsolatedEnv, spawnOpencode } from "../src/opencode-runner/spawn";
import { resolvePiHostInvocation } from "../src/pi-runner/spawn";

// Opt in only from a throwaway root; HOME and every storage/config override must also be isolated.
const root = realpathSync(tmpdir());
const enabled = /\/magic-context\/historian-no-tools(?:\/|$)/.test(root);
const variants = ["historian", "historian-recomp", "historian-editor"];
function assertIsolatedProcess(pid: number) {
	const opened = execFileSync("lsof", ["-Fn", "-p", String(pid)], {
		encoding: "utf8",
	});
	const dbPaths = opened
		.split("\n")
		.filter(
			(line) => line.startsWith("n/") && /\.db(?:-wal|-shm)?$/.test(line),
		);
	console.log(
		`historian-no-tools lsof pid=${pid} db=${JSON.stringify(dbPaths)}`,
	);
	expect(
		dbPaths.every((line) => resolve(line.slice(1)).startsWith(root + "/")),
	).toBe(true);
	return dbPaths;
}

(enabled ? test : test.skip)(
	"OpenCode 1.18.30 historian variants send no tool definitions despite user overrides",
	async () => {
		expect(
			execFileSync("opencode", ["--version"], { encoding: "utf8" }).trim(),
		).toBe("1.18.30");
		const env = createIsolatedEnv();
		const home = join(env.workdir, "home");
		mkdirSync(home);
		const mock = new MockProvider();
		const { baseURL } = await mock.start();
		mock.setDefault({
			text: "<compartments/>",
			usage: { input_tokens: 1000, output_tokens: 20 },
		});
		let host: Awaited<ReturnType<typeof spawnOpencode>> | undefined;
		try {
			host = await spawnOpencode({
				mockProviderURL: baseURL,
				existingEnv: env,
				extraEnv: { HOME: home },
				magicContextConfig: {
					dreamer: { disable: true },
					historian: {
						opencode: { model: "mock-anthropic/mock-sonnet" },
						tools: { read: true, aft_search: true },
						permission: { "*": "allow", read: "allow" },
					},
					memory: { auto_promote: false, auto_search: { enabled: false } },
				},
			});
			const client = createOpencodeClient({ baseUrl: host.url });
			for (const agent of variants) {
				const session = await client.session.create({
					query: { directory: env.workdir },
				});
				const id = session.data?.id;
				if (!id) throw new Error("Historian session absent");
				const marker = `NO_TOOLS_PROBE_${agent}`;
				const reply = await client.session.prompt({
					path: { id },
					body: {
						agent,
						model: { providerID: "mock-anthropic", modelID: "mock-sonnet" },
						parts: [{ type: "text", text: marker }],
					},
				});
				expect(reply.error).toBeUndefined();
				const requests = mock
					.requests()
					.filter((r) => JSON.stringify(r.body.messages).includes(marker));
				expect(requests.length).toBeGreaterThan(0);
				for (const request of requests)
					expect(request.body.tools ?? []).toEqual([]);
				console.log(
					`OpenCode ${agent}: ${requests.length} captured requests, zero tools`,
				);
			}
			expect(assertIsolatedProcess(host.pid).length).toBeGreaterThan(0);
		} finally {
			await host?.kill();
			await mock.stop();
		}
	},
	300_000,
);

(enabled ? test : test.skip)(
	"Pi historian variants send no tool definitions even when an extension registers a tool",
	async () => {
		for (const name of [
			"HOME",
			"XDG_DATA_HOME",
			"XDG_CONFIG_HOME",
			"MAGIC_CONTEXT_STORAGE_DIR",
		]) {
			expect(realpathSync(process.env[name] ?? "").startsWith(root + "/")).toBe(
				true,
			);
		}
		const agentDir = join(root, "pi-agent");
		mkdirSync(agentDir, { recursive: true });
		process.env.PI_CODING_AGENT_DIR = agentDir;
		const extension = join(root, "tool-extension.ts");
		writeFileSync(
			extension,
			`export default function(pi) { pi.registerTool({ name: "probe_tool", label: "Probe", description: "Must not reach historian", parameters: { type: "object", properties: {} }, execute: async () => ({ content: [{ type: "text", text: "unused" }] }) }); }`,
		);
		const mock = new MockProvider();
		const { baseURL } = await mock.start();
		writeFileSync(
			join(agentDir, "models.json"),
			JSON.stringify({
				providers: {
					anthropic: {
						baseUrl: baseURL,
						apiKey: "test-key-not-real",
						modelOverrides: { "claude-haiku-4-5": { reasoning: false } },
					},
				},
			}),
		);
		mock.setDefault({
			text: "<compartments/>",
			usage: { input_tokens: 1000, output_tokens: 20 },
		});
		const runner = new PiSubagentRunner({
			invocation: resolvePiHostInvocation("pi"),
			subagentExtensions: [extension],
		});
		let pid: number | undefined;
		mock.addMatcher(() => {
			if (pid) assertIsolatedProcess(pid);
			return null;
		});
		try {
			for (const agent of ["magic-context-historian", ...variants]) {
				const start = mock.requests().length;
				const result = await runner.run({
					agent,
					systemPrompt: "Return historian XML from the supplied text only.",
					userMessage: `NO_TOOLS_PROBE_${agent}`,
					model: "anthropic/claude-haiku-4-5",
					timeoutMs: 30_000,
					cwd: root,
					onProgress: (event) => {
						if (event.type === "spawned") pid = event.pid;
					},
				});
				if (!result.ok) throw new Error(JSON.stringify(result));
				const requests = mock.requests().slice(start);
				expect(requests.length).toBeGreaterThan(0);
				for (const request of requests)
					expect(request.body.tools ?? []).toEqual([]);
				console.log(
					`Pi ${agent}: ${requests.length} captured requests, zero tools`,
				);
			}
		} finally {
			await mock.stop();
		}
	},
	300_000,
);
