import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	closeSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	openSync,
	readdirSync,
	readSync,
	realpathSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { pinMockAgents } from "../mock-routing";
import { MockProvider, type MockResponse } from "../mock-provider/server";
import {
	awaitPluginActivation,
	type PluginActivationClient,
} from "./plugin-activation";

export const OPENCODE2_NO_BACKGROUND_SERVICE_FLAG: string = "--standalone";
export const ROOT_KEYS = [
	"HOME",
	"XDG_CONFIG_HOME",
	"XDG_DATA_HOME",
	"XDG_STATE_HOME",
	"XDG_CACHE_HOME",
] as const;
// The GA CLI is a devDependency of packages/plugin. Bun's isolated linker puts its
// bin under the package's own node_modules; the hoisted linker (the release e2e
// container installs with --linker=hoisted) puts it under the workspace root. Take
// whichever exists so the lane does not depend on the linker choice.
export const CLI = [
	resolve(import.meta.dir, "../../../plugin/node_modules/.bin/opencode2"),
	resolve(import.meta.dir, "../../../../node_modules/.bin/opencode2"),
].find((candidate) => existsSync(candidate)) ?? resolve(import.meta.dir, "../../../plugin/node_modules/.bin/opencode2");
export const PLUGIN = resolve(import.meta.dir, "../../../plugin");
const groups = new Set<number>();
function killGroup(pid: number): void {
	try {
		process.kill(-pid, "SIGKILL");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
	}
}
process.once("exit", () => {
	for (const pid of groups) killGroup(pid);
});
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
	process.once(signal, () => {
		for (const pid of groups) killGroup(pid);
		process.exit(1);
	});
}
export interface OpenCode2Isolation {
	root: string;
	env: NodeJS.ProcessEnv;
	cwd: string;
}

export function isolation(): OpenCode2Isolation {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "mc-opencode2-")));
	const env: NodeJS.ProcessEnv = {
		PATH: process.env.PATH,
		OPENCODE_DB: "opencode2.db",
		OPENCODE_DISABLE_DEFAULT_PLUGINS: "true",
	};
	for (const key of ROOT_KEYS) {
		env[key] = join(root, key);
		mkdirSync(env[key]);
	}
	const cwd = join(root, "work");
	mkdirSync(cwd);
	return { root, env, cwd };
}
export function assertIsolation(root: string, env: NodeJS.ProcessEnv): void {
	if (!OPENCODE2_NO_BACKGROUND_SERVICE_FLAG.trim())
		throw new Error(
			"Missing OPENCODE2_NO_BACKGROUND_SERVICE_FLAG literal; refusing v2 boot",
		);
	if (env.OPENCODE_DB !== "opencode2.db")
		throw new Error("OPENCODE_DB must be opencode2.db before boot");
	// The five private roots are the safety boundary (AFT playbook:46-48,62).
	// GA CLI 2.0.5 also honours OPENCODE_DB as observed by the placement probe.
	const base = realpathSync(root);
	for (const key of ROOT_KEYS) {
		const value = env[key];
		if (!value)
			throw new Error(`${key} must point at a throwaway directory before boot`);
		const suffix = relative(base, realpathSync(value));
		if (!suffix || suffix.startsWith("..") || resolve(value) === homedir())
			throw new Error(`${key} is not a throwaway directory before boot`);
	}
	if (env.OPENCODE_DISABLE_DEFAULT_PLUGINS !== "true")
		throw new Error("Default plugins must be disabled");
}
const sha = (bytes: Uint8Array) =>
	createHash("sha256").update(bytes).digest("hex");
export function snapshotFile(path: string) {
	if (!existsSync(path)) return null;
	const stat = statSync(path);
	const fd = openSync(path, "r");
	const edge = (position: number) => {
		const buffer = Buffer.alloc(Math.min(stat.size, 1024 * 1024));
		const count = readSync(fd, buffer, 0, buffer.length, position);
		if (count !== buffer.length)
			throw new Error(`Short live-store snapshot read: ${path}`);
		return sha(buffer);
	};
	try {
		return {
			size: stat.size,
			mtime: stat.mtimeMs,
			first: edge(0),
			last: edge(Math.max(0, stat.size - 1024 * 1024)),
		};
	} finally {
		closeSync(fd);
	}
}
export function snapshotLive(home = homedir()) {
	const root = join(home, ".local/share/opencode");
	const log = join(root, "log");
	return {
		db: snapshotFile(join(root, "opencode.db")),
		logs: existsSync(log)
			? readdirSync(log)
					.sort()
					.map((name) => ({ name, ...snapshotFile(join(log, name)) }))
			: null,
	};
}
export function assertLiveUnchanged(
	before: ReturnType<typeof snapshotLive>,
	home = homedir(),
): void {
	if (JSON.stringify(before) !== JSON.stringify(snapshotLive(home)))
		throw new Error("Operator live store/log changed during v2 boot");
}
export function handoff(
	stdout: string,
): { url: string; password: string } | undefined {
	const match = stdout.match(
		/server listening on (https?:\/\/\S+)[\s\S]*?server password (\S+)/,
	);
	return match ? { url: match[1]!, password: match[2]! } : undefined;
}

/** OpenCode 2.0.5 removed awaitActivation; inventory is authoritative and plugin.updated invalidates it. */
export async function waitForPluginActive(
	client: PluginActivationClient,
	directory: string,
	pluginID = "opencode-magic-context",
	timeoutMs = 20_000,
): Promise<void> {
	await awaitPluginActivation(client, directory, pluginID, timeoutMs);
}


export interface OpenCode2SpawnOptions {
	probePlugin?: string;
	providerID?: string;
	probeStandalone?: boolean;
	defaultModelID?: string;
	additionalModelIDs?: string[];
	mockResponse?: MockResponse;
	extraConfig?: Record<string, unknown>;
	magicContextConfig?: Record<string, unknown>;
	includeMagicContext?: boolean;
	modelContextLimit?: number;
	modelOutputLimit?: number;
	existingIsolation?: OpenCode2Isolation;
	existingMock?: { mock: MockProvider; baseURL: string };
}

/** Event-driven, bounded startup; no readiness polling. CLI contract: AFT playbook:54-64. */
export async function spawnOpencode2(options: OpenCode2SpawnOptions = {}) {
	const providerID = options.providerID ?? "openai";
	const fixture = options.existingIsolation ?? isolation();
	const snapshotReason = activeV1Host()
		? "live snapshot skipped: active v1 opencode serve writes operator store"
		: undefined;
	const before = snapshotReason ? undefined : snapshotLive();
	assertIsolation(fixture.root, fixture.env);
	if (
		options.includeMagicContext !== false &&
		!existsSync(join(PLUGIN, "dist/v2/server.js"))
	) {
		throw new Error("Build the plugin before booting v2");
	}
	const mock = options.existingMock?.mock ?? new MockProvider();
	const provider = options.existingMock ?? await mock.start(); // Existing mock explicitly binds 127.0.0.1 and captures parsed wire bodies.
	// 2.0.5 title generation hits the mock on session.create, before tests
	// install matchers, and uses a host title model rather than mock-model.
	mock.setDefault({
		text: "fixture reply",
		usage: { input_tokens: 100, output_tokens: 10 },
	});
	if (options.mockResponse) mock.setDefault(options.mockResponse);
	const defaultModelID = options.defaultModelID ?? "mock-model";
	const modelIDs = new Set([
		defaultModelID,
		...(options.additionalModelIDs ?? []),
	]);
	writeFileSync(
		join(fixture.cwd, "opencode.json"),
		JSON.stringify({
			...options.extraConfig,
			plugins: [
				...(options.includeMagicContext === false ? [] : [PLUGIN]),
				...(options.probePlugin ? [options.probePlugin] : []),
			],
			model: `${providerID}/${defaultModelID}`,
			compaction: { auto: true, buffer: 1024, keep: { tokens: 1024 } },
			providers: {
				[providerID]: {
					settings: { baseURL: provider.baseURL, apiKey: "mock-key" },
					models: Object.fromEntries(
						[...modelIDs].map((id) => [
							id,
							{
								name: id,
								limit: {
									// 2.0.5 required() is unchanged, but 16k minus a 32k output
									// makes the first-request ceiling negative. Ordinary turns
									// stay large; fold scenarios pass 16k/1024 explicitly.
									context: options.modelContextLimit ?? 200_000,
									output: options.modelOutputLimit ?? 32768,
								},
							},
						]),
					),
				},
			},
		}),
	);
	if (options.magicContextConfig !== undefined) {
		const configDir = join(fixture.env.XDG_CONFIG_HOME!, "cortexkit");
		mkdirSync(configDir, { recursive: true });
		writeFileSync(
			join(configDir, "magic-context.jsonc"),
			JSON.stringify(
				{
					auto_update: false,
					execute_threshold_percentage: 40,
					history_budget_percentage: 0.15,
					embedding: { provider: "off" },
					...pinMockAgents(
						options.magicContextConfig,
						`${providerID}/${defaultModelID}`,
						"opencode2",
					),
				},
				null,
				2,
			),
		);
	}
	// serve owns its server directly; --standalone is a TUI/run flag, not a serve option.
	const child = spawn(
		CLI,
		[
			"serve",
			"--hostname",
			"127.0.0.1",
			"--port",
			"0",
			...(options.probeStandalone
				? [OPENCODE2_NO_BACKGROUND_SERVICE_FLAG]
				: []),
			"--print-logs",
		],
		{
			cwd: fixture.cwd,
			env: fixture.env,
			detached: true,
			stdio: ["ignore", "pipe", "pipe"],
		},
	);
	if (child.pid) groups.add(child.pid);
	let stdout = "";
	let stderr = "";
	const exited = new Promise<void>((resolveExit) =>
		child.once("close", () => resolveExit()),
	);
	let hostStopped = false;
	const stopHost = async () => {
		if (hostStopped) return;
		hostStopped = true;
		let safetyError: unknown;
		try {
			if (child.pid && child.exitCode === null && child.signalCode === null)
				inspectOpenFiles(child.pid, fixture.root, fixture.env);
		} catch (error) {
			safetyError = error;
		}
		if (child.pid) killGroup(child.pid);
		await exited;
		if (child.pid) groups.delete(child.pid);
		if (before) assertLiveUnchanged(before);
		if (safetyError) throw safetyError;
	};
	const stop = async () => {
		try {
			await stopHost();
		} finally {
			await mock.stop();
		}
	};
	try {
		const ready = await new Promise<{ url: string; password: string }>(
			(resolveReady, reject) => {
				const timer = setTimeout(
					() => reject(new Error(`v2 handoff timed out\n${stdout}\n${stderr}`)),
					30000,
				);
				const finish = (error?: Error) => {
					clearTimeout(timer);
					if (error) reject(error);
				};
				child.stdout.on("data", (chunk) => {
					stdout += chunk.toString();
					const value = handoff(stdout);
					if (value) {
						finish();
						resolveReady(value);
					}
				});
				child.stderr.on("data", (chunk) => {
					stderr += chunk.toString();
				});
				child.once("error", (error) => finish(error));
				child.once("close", (code) =>
					finish(new Error(`v2 exited ${code}\n${stdout}\n${stderr}`)),
				);
			},
		);
		if (child.pid) inspectOpenFiles(child.pid, fixture.root, fixture.env);
		return {
			...ready,
			...fixture,
			snapshotReason,
			mock,
			mockBaseURL: provider.baseURL,
			stopHost,
			stop,
			stdout: () => stdout,
			stderr: () => stderr,
		};
	} catch (error) {
		await stop();
		throw error;
	}
}

function activeV1Host(): boolean {
	const result = spawnSync("pgrep", ["-alf", "opencode"], {
		encoding: "utf8",
	});
	if (result.error || (result.status !== 0 && result.status !== 1))
		throw new Error("Cannot determine whether a live OpenCode host owns the store");
	return result.status === 0 && result.stdout.split("\n").some((line) => /\bserve\b/.test(line));
}

export function assertOpenPaths(
	paths: string[],
	root: string,
	allowed: string[] = [],
): void {
	const under = (path: string, base: string) =>
		path === base || path.startsWith(`${base}/`);
	const live = join(homedir(), ".local/share/opencode");
	for (const path of paths) {
		if (!path.startsWith("/")) continue; // lsof socket/pipe labels are not filesystem paths.
		const bunLibrary =
			/^\/private\/tmp\/\.bun-\d+-[a-f0-9]+\.(dylib|node)$/.test(path);
		if (
			under(path, live) ||
			(!bunLibrary &&
				![
					root,
					...allowed,
					"/dev",
					"/System",
					"/usr/lib",
					"/usr/share",
					"/private/etc",
					"/Library/Apple/System",
					"/private/var/db/diagnostics",
					"/private/var/db/uuidtext",
					"/private/var/db/timezone",
					"/private/var/db/mds/messages",
					"/private/var/db/analyticsd/events.allowlist",
				].some((base) => under(path, base)))
		) {
			throw new Error(`v2 process holds a forbidden open path: ${path}`);
		}
	}
}

/** Sample the whole child process group, not an unrelated operator process's writes. */
export function inspectOpenFiles(
	pid: number,
	root: string,
	env: NodeJS.ProcessEnv,
): string[] {
	const ps = spawnSync("ps", ["-axo", "pid=,pgid="], { encoding: "utf8" });
	if (ps.status !== 0) throw new Error("Cannot inspect v2 process group");
	const pids = ps.stdout
		.trim()
		.split("\n")
		.map((line) => line.trim().split(/\s+/))
		.filter(([, group]) => Number(group) === pid)
		.map(([id]) => id);
	if (!pids.length)
		throw new Error("v2 process group disappeared before fd inspection");
	const result = spawnSync("lsof", ["-p", pids.join(","), "-Fin"], {
		encoding: "utf8",
	});
	if (result.status !== 0)
		throw new Error(`Cannot inspect v2 open files: ${result.stderr}`);
	const paths = result.stdout
		.split("\n")
		.filter((line) => line.startsWith("n"))
		.map((line) => line.slice(1));
	assertOpenPaths(paths, root, [
		realpathSync(resolve(PLUGIN, "../../node_modules")),
		realpathSync(CLI),
	]);
	const db = join(env.XDG_DATA_HOME!, "opencode", env.OPENCODE_DB!);
	const expected = statSync(db);
	let inode: number | undefined;
	const placements = result.stdout.split("\n").some((line) => {
		if (line.startsWith("i")) inode = Number(line.slice(1));
		return line === `n${db}` && inode === expected.ino;
	});
	if (!placements)
		throw new Error(
			"v2 child did not open its throwaway XDG_DATA_HOME database",
		);
	return paths;
}
