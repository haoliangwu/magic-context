/// <reference types="bun-types" />
import { expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { buildArgs } from "../../pi-plugin/src/subagent-runner";
import { OMP_CHILD_TOOL_CONFIG } from "../../pi-plugin/src/subagent-tool-boundary";
import { MockProvider } from "../src/mock-provider/server";
import { forEachHost } from "../src/scenario-hosts";

const zeroToolAgents = [
	"magic-context-historian",
	"historian",
	"historian-recomp",
	"historian-editor",
	"smart-note-compiler",
	"dreamer-classifier",
	"dreamer-reviewer",
	"historian-check",
];

const aftTools = ["aft_search"];

forEachHost(import.meta.url, null, (host) => {
	if (host !== "pi" && host !== "omp")
		throw new Error(`unsupported host ${host}`);
	const versions =
		host === "omp"
			? [
					["omp-coding-agent-1812", "18.12.3"],
					["omp-coding-agent-18126", "18.12.6"],
				]
			: [
					["pi-coding-agent-087", "0.87.1"],
					["pi-coding-agent-130", "1.3.0"],
				];
	for (const [alias, version] of versions) {
		it(`${host} ${version}: tool-free children reject discovered tools and preserve allowlists`, async () => {
			const scratch = resolve(
				import.meta.dir,
				"../../..",
				"target/scratch/child-tool-boundary",
			);
			mkdirSync(scratch, { recursive: true });
			const root = mkdtempSync(join(scratch, `${alias}-`));
			const agentDir = join(root, "agent");
			const workdir = join(root, "work");
			mkdirSync(join(agentDir, "extensions"), { recursive: true });
			mkdirSync(workdir);
			const mock = new MockProvider();
			const { baseURL } = await mock.start();
			const packageRoot = resolve(
				import.meta.dir,
				"../../pi-plugin/node_modules",
				alias!,
			);
			expect(
				JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"))
					.version,
			).toBe(version);
			const cli = join(
				packageRoot,
				host === "omp" ? "src/cli.ts" : "dist/cli.js",
			);
			writeFileSync(
				join(agentDir, host === "omp" ? "config.yml" : "settings.json"),
				JSON.stringify({
					compaction: { enabled: false },
					retry: { enabled: false },
				}),
			);
			const marker = join(root, "marker");
			const inventory = join(root, "active.json");
			const systemPromptPath = join(root, "system-prompt.txt");
			writeFileSync(systemPromptPath, "Reply once.");
			const ompToolConfigPath = join(root, "tool-boundary.yml");
			writeFileSync(ompToolConfigPath, OMP_CHILD_TOOL_CONFIG);
			// The model exists only in this discovered extension, so disabling
			// discovery would prevent the child from reaching the mock provider.
			writeFileSync(
				join(agentDir, "extensions/probe.ts"),
				`
import { writeFileSync } from "node:fs";
export default function(pi) {
    pi.registerProvider("mock", {
        api: "anthropic-messages", baseUrl: ${JSON.stringify(baseURL)}, apiKey: "inert-test-key",
        models: [{ id: "mock-model", name: "Mock", input: ["text"], contextWindow: 200000,
            maxTokens: 1024, reasoning: false, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
    });
    for (const name of ["e2e_marker", "aft_search"]) pi.registerTool({ name, label: "Inert marker", description: "Write a throwaway marker",
        parameters: { type: "object", properties: {} },
        async execute() { writeFileSync(${JSON.stringify(marker)}, "executed"); return { content: [{ type: "text", text: "marked" }], details: {} }; }
    });
    pi.on("context", () => { writeFileSync(${JSON.stringify(inventory)}, JSON.stringify(pi.getActiveTools())); });
}
`,
			);
			expect(existsSync(join(agentDir, "models.json"))).toBe(false);
			const env: Record<string, string> = {
				PATH: process.env.PATH!,
				HOME: root,
				CFFIXED_USER_HOME: root,
				TMPDIR: root,
				XDG_CONFIG_HOME: join(root, "config"),
				XDG_DATA_HOME: join(root, "data"),
				XDG_CACHE_HOME: join(root, "cache"),
				XDG_STATE_HOME: join(root, "state"),
				XDG_RUNTIME_DIR: join(root, "runtime"),
				PI_CODING_AGENT_DIR: agentDir,
				MAGIC_CONTEXT_STORAGE_DIR: join(root, "storage"),
				MAGIC_CONTEXT_PI_SUBAGENT: "1",
				PI_OFFLINE: "1",
				PI_SKIP_VERSION_CHECK: "1",
				ANTHROPIC_API_KEY: "inert-test-key",
			};
			try {
				const readers =
					host === "omp"
						? ["read", "grep", "glob"]
						: ["read", "grep", "find", "ls"];
				const cases: Array<[string, string[]]> = [
					...zeroToolAgents.map((agent): [string, string[]] => [agent, []]),
					["dreamer-memory-mapper", [...readers, ...aftTools]],
					["dreamer-docs", [...readers, ...aftTools]],
					[
						"dreamer-primer-investigator",
						[...readers, ...aftTools, "ctx_search"],
					],
					["dreamer-retrospective", ["ctx_search"]],
					["dreamer", ["ctx_memory", "ctx_memory_list"]],
					["magic-context-dreamer", ["ctx_memory", "ctx_memory_list"]],
				];
				for (const [agent, expected] of cases) {
					rmSync(marker, { force: true });
					rmSync(inventory, { force: true });
					const before = mock.requests().length;
					let checked = false;
					let childPid: number;
					mock.script([
						{
							content: [
								{
									type: "tool_use",
									id: "inert-call",
									name: "e2e_marker",
									input: {},
								},
							],
							stop_reason: "tool_use",
							usage: { input_tokens: 100, output_tokens: 20 },
						},
						{ text: "done", usage: { input_tokens: 100, output_tokens: 20 } },
					]);
					mock.addMatcher(() => {
						if (!checked) {
							const opened = execFileSync(
								"lsof",
								["-Fn", "-p", String(childPid)],
								{ encoding: "utf8" },
							);
							const stores = opened
								.split("\n")
								.filter((line) =>
									/^n.*\.(?:db|sqlite)(?:-wal|-shm)?$/.test(line),
								);
							expect(stores.every((line) => line.startsWith(`n${root}/`))).toBe(
								true,
							);
							console.log(
								`${host} ${version} ${agent} lsof databases=${stores.length}, all under ${root}`,
							);
							checked = true;
						}
						return null;
					});
					const args = buildArgs(
						{
							agent,
							model: "mock/mock-model",
							systemPrompt: "Reply once.",
							userMessage: "Tool boundary probe",
						},
						{
							targetHarness: host,
							ompToolConfigPath,
							systemPromptPath,
							subagentEntryPath: resolve(
								import.meta.dir,
								"../../pi-plugin/dist/subagent-entry.js",
							),
							historianCalibrationEntryPath: resolve(
								import.meta.dir,
								"../../pi-plugin/dist/historian-calibration-extension.js",
							),
						},
					);
					expect(args).not.toContain("--no-extensions");
					const child = Bun.spawn([process.execPath, cli, ...args], {
						cwd: workdir,
						env,
						stdout: "pipe",
						stderr: "pipe",
						timeout: 30000,
					});
					childPid = child.pid;
					const [exit, stdout, stderr] = await Promise.all([
						child.exited,
						new Response(child.stdout).text(),
						new Response(child.stderr).text(),
					]);
					expect(exit, `${stdout}\n${stderr}`).toBe(0);
					expect(stdout).toContain('"type":"agent_end"');
					expect(stdout).toContain('"text":"done"');
					expect(checked).toBe(true);
					const requests = mock.requests().slice(before);
					expect(requests.length).toBeGreaterThan(0);
					const active = JSON.parse(readFileSync(inventory, "utf8"));
					const offered = requests.flatMap((r) =>
						Array.isArray(r.body.tools)
							? r.body.tools.map((t: { name: string }) => t.name)
							: [],
					);
					const executed = existsSync(marker);
					console.log(
						`MEASURE ${host} ${version} ${agent}: active=${JSON.stringify(active)} offered=${JSON.stringify(offered)} executed=${executed}`,
					);
					expect([...active].sort()).toEqual([...expected].sort());
					for (const request of requests) {
						const names = Array.isArray(request.body.tools)
							? request.body.tools.map((t: { name: string }) =>
									t.name.replace(/^_/, ""),
								)
							: [];
						expect(names.sort()).toEqual([...expected].sort());
					}
					expect(executed).toBe(false);
				}
			} finally {
				await mock.stop();
				rmSync(root, { recursive: true, force: true });
			}
		}, 120000);
	}
});
