import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { OpenCode } from "@opencode/client";
import { MockProvider } from "../../src/mock-provider/server";
import { assertIsolation, isolation, spawnOpencode2, waitForPluginActive } from '../../src/opencode2-runner/spawn';

const root = resolve(import.meta.dir, "../../src/opencode2-runner");
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
async function v1Body(): Promise<Record<string, unknown>> {
	const fixture = isolation();
	const mock = new MockProvider();
	const endpoint = await mock.start();
	mock.setDefault({
		text: "probe reply",
		usage: { input_tokens: 100, output_tokens: 10 },
	});
	writeFileSync(
		join(fixture.cwd, "opencode.json"),
		JSON.stringify({
			plugin: [`file://${join(root, "payload-v1.mjs")}`],
			model: "mock-anthropic/mock-model",
			small_model: "mock-anthropic/mock-model",
			compaction: { auto: false, prune: false },
			provider: {
				"mock-anthropic": {
					npm: "@ai-sdk/anthropic",
					options: { baseURL: endpoint.baseURL, apiKey: "mock-key" },
					models: {
						"mock-model": {
							name: "Mock",
							limit: { context: 200000, output: 1024 },
						},
					},
				},
			},
		}),
	);
	assertIsolation(fixture.root, fixture.env);
	const child = spawn(
		"opencode",
		["serve", "--hostname", "127.0.0.1", "--port", "0"],
		{
			cwd: fixture.cwd,
			env: fixture.env,
			detached: true,
			stdio: ["ignore", "pipe", "pipe"],
		},
	);
	const exited = new Promise<void>((done) => child.once("close", () => done()));
	const reap = () => {
		if (child.pid) {
			try {
				process.kill(-child.pid, "SIGKILL");
			} catch {}
		}
	};
	process.once("exit", reap);
	try {
		const url = await new Promise<string>((done, reject) => {
			let stdout = "";
			let stderr = "";
			const timer = setTimeout(
				() => reject(new Error(`v1 handoff timeout: ${stdout}\n${stderr}`)),
				30000,
			);
			child.stdout.on("data", (chunk) => {
				stdout += chunk;
				const found = stdout.match(/server listening on (http:\/\/\S+)/);
				if (found) {
					clearTimeout(timer);
					done(found[1]!);
				}
			});
			child.stderr.on("data", (chunk) => {
				stderr += chunk;
			});
			child.once("error", (error) => {
				clearTimeout(timer);
				reject(error);
			});
			child.once("exit", (code) => {
				clearTimeout(timer);
				reject(new Error(`v1 exited ${code}: ${stderr}`));
			});
		});
		const sessionResponse = await fetch(`${url}/session`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: "{}",
			signal: AbortSignal.timeout(90000),
		});
		expect(sessionResponse.ok).toBe(true);
		const session = (await sessionResponse.json()) as { id: string };
		const prompt = await fetch(`${url}/session/${session.id}/message`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				model: { providerID: "mock-anthropic", modelID: "mock-model" },
				parts: [{ type: "text", text: "continue probe" }],
			}),
			signal: AbortSignal.timeout(90000),
		});
		expect(prompt.ok).toBe(true);
		const request = mock
			.requests()
			.find((request) => JSON.stringify(request.body).includes("call_probe"));
		expect(request).toBeDefined();
		return request!.body;
	} finally {
		reap();
		await exited;
		EventEmitter.prototype.removeListener.call(process, "exit", reap);
		await mock.stop();
	}
}

test("payload_identity_probe records real v1 and v2 provider bodies", async () => {
	const v1 = await v1Body();
	const host = await spawnOpencode2({
		probePlugin: join(root, "payload-v2"),
		providerID: "anthropic",
	});
	let v2: Record<string, unknown>;
	try {
		const client = OpenCode.make({
			baseUrl: host.url,
			headers: { authorization: `Basic ${btoa(`opencode:${host.password}`)}` },
		});
		const session = await client.session.create({
			location: { directory: host.cwd },
			model: { providerID: "anthropic", id: "mock-model" },
		});
		await waitForPluginActive(client, host.cwd);
		host.mock.setDefault({
			text: "probe reply",
			usage: { input_tokens: 100, output_tokens: 10 },
		});
		await client.session.prompt({
			sessionID: session.id,
			text: "continue probe",
		});
		await client.session.wait(
			{ sessionID: session.id },
			{ signal: AbortSignal.timeout(20000) },
		);
		const request = host.mock
			.requests()
			.find((request) => JSON.stringify(request.body).includes("call_probe"));
		if (!request)
			console.error(
				JSON.stringify(await client.session.context({ sessionID: session.id })),
				host.stderr(),
			);
		expect(request).toBeDefined();
		v2 = request!.body;
	} finally {
		await host.stop();
	}
	for (const body of [v1, v2]) {
		const bytes = JSON.stringify(body);
		for (const text of [
			"probe text",
			"probe thinking",
			"call_probe",
			"probe result",
		])
			expect(bytes).toContain(text);
	}
	const a = JSON.stringify(v1);
	const b = JSON.stringify(v2);
	const verdict = a === b ? "identical" : "divergent";
	if (process.env.OC2_RECORD_PROBES === "1") {
		writeFileSync(join(root, "payload-v1.json"), a + "\n");
		writeFileSync(join(root, "payload-v2.json"), b + "\n");
		writeFileSync(
			join(root, "probe-results.json"),
			JSON.stringify(
				{
					payload_identity_probe: {
						verdict,
						v1_sha256: sha(a + "\n"),
						v2_sha256: sha(b + "\n"),
						diff: Object.keys({ ...v1, ...v2 }).filter(
							(key) => JSON.stringify(v1[key]) !== JSON.stringify(v2[key]),
						),
						note: "Same logical draft; native host hook adapters in payload-v1.mjs and payload-v2/server.js. Bodies captured by the existing mock, including host-owned tools/options.",
					},
					hidden_agent_surface_probe: {
						verdict: "session.create with explicit model, then session.prompt",
						evidence:
							"@opencode/client@2.0.5 dist/promise/client.d.ts:22-25,32-54; dist/promise/generated/types.d.ts SessionCreateInput. AgentEditor exposes list/get/default/update/remove, no add; GA plugin-promise-session.d.ts:105 exposes create/prompt.",
					},
					rpc_entry_absence_probe: {
						verdict: "tolerated; no stub",
						evidence:
							"ga/plugin-host.js:13-29; executed Host.resolve for both name and directory targets in server.test.ts",
					},
					cli: {
						version: "2.0.5",
						standalone:
							"serve --standalone exits 1: Unrecognized flag: --standalone in command opencode serve. Runner uses direct serve --port 0 with private roots.",
						evidence:
							"GA core dist/chunks/mime-0gc96ev3.js:274 and serve --help; AFT playbook:54-64",
						database:
							"Observed OPENCODE_DB honoured: XDG_DATA_HOME/opencode/opencode2.db plus WAL/SHM, no opencode.db. CLI read site not located in compiled native binary; upstream source rule oc-audit-7a31b5c0f7.md:186-202.",
						live_snapshot:
							"Skipped when pgrep finds active v1 opencode serve; fd/process-group and inode placement guards still mandatory (owner correction).",
					},
				},
				null,
				2,
			) + "\n",
		);
	} else {
		const recorded = JSON.parse(
			readFileSync(join(root, "probe-results.json"), "utf8"),
		);
		expect(verdict).toBe(recorded.payload_identity_probe.verdict);
	}
}, 180000);

test("hidden_agent_surface_probe selects explicit-model child sessions", () => {
	const client = OpenCode.make({ baseUrl: "http://127.0.0.1:1" });
	expect(Object.keys(client.agent).sort()).toEqual(["get", "list"]);
	expect(typeof client.session.create).toBe("function");
	expect(typeof client.session.prompt).toBe("function");
	const editor = readFileSync(
		resolve(
			import.meta.dir,
			"../../../plugin/node_modules/@opencode/plugin/dist/promise/agent.d.ts",
		),
		"utf8",
	);
	expect(editor).toContain("transform: Transform<AgentEditor>");
	expect(editor).not.toMatch(/\b(add|register)\s*\(/);
});
