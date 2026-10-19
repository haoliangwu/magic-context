import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	closeDatabase,
	openDatabase,
} from "@magic-context/core/features/magic-context/storage-db";
import { _resetHarnessForTesting } from "@magic-context/core/shared/harness";
import {
	cleanupTestTempDir,
	createTestTempDir,
} from "../../plugin/src/shared/test-temp-dir";
import * as dreamer from "./dreamer";
import extension from "./index";

const originalEnv = { ...process.env };
const originalCwd = process.cwd();
let root: string;
afterEach(() => {
	_resetHarnessForTesting();
	closeDatabase();
	process.chdir(originalCwd);
	process.env = { ...originalEnv };
	if (root) cleanupTestTempDir(root);
});

for (const disable of [true, false]) {
	test(`Pi registers independent git maintenance with dreamer.disable=${disable}`, async () => {
		root = createTestTempDir("pi-independent-git-").dir;
		for (const key of [
			"HOME",
			"XDG_DATA_HOME",
			"XDG_CONFIG_HOME",
			"XDG_CACHE_HOME",
			"XDG_STATE_HOME",
			"XDG_RUNTIME_DIR",
			"MAGIC_CONTEXT_TEST_CONFIG_DIR",
		]) {
			const directory = join(root, key);
			process.env[key] = directory;
			mkdirSync(directory, { recursive: true });
		}
		process.env.MAGIC_CONTEXT_TEST_DATA_DIR = root;
		process.env.OPENCODE_DB = join(root, "absent.db");
		process.chdir(root);
		mkdirSync(join(root, ".cortexkit"));
		writeFileSync(
			join(root, ".cortexkit/magic-context.jsonc"),
			JSON.stringify({
				auto_update: false,
				embedding: { provider: "off" },
				historian: { disable: true },
				dreamer: { disable },
				memory: {
					enabled: false,
					git_commit_indexing: {
						enabled: true,
						since_days: 17,
						max_commits: 173,
					},
				},
			}),
		);
		const db = openDatabase();
		if (!db) throw new Error("throwaway store unavailable");
		const registrations: Parameters<
			typeof dreamer.registerPiDreamerProject
		>[0][] = [];
		const realRegister = dreamer.registerPiDreamerProject;
		const register = spyOn(
			dreamer,
			"registerPiDreamerProject",
		).mockImplementation((opts) => {
			registrations.push(opts);
			realRegister(opts);
		});
		const handlers = new Map<string, (...args: unknown[]) => unknown>();
		const api = {
			on: (name: string, handler: (...args: unknown[]) => unknown) => {
				handlers.set(name, handler);
			},
			events: { on: () => () => {} },
			registerTool() {},
			registerCommand() {},
			registerShortcut() {},
			registerFlag() {},
			registerMessageRenderer() {},
			registerEntryRenderer() {},
			appendEntry() {},
			getAllTools: () => [],
			getActiveTools: () => [],
			getFlag: () => undefined,
		};
		try {
			await extension(api as never);
			const before = handlers.get("before_agent_start");
			expect(before).toBeFunction();
			if (!before) throw new Error("before_agent_start was not registered");
			await before(
				{},
				{
					cwd: root,
					hasUI: true,
					ui: { notify() {}, setStatus() {}, setWidget() {} },
				},
			);
			expect(registrations.length).toBeGreaterThan(0);
			expect(dreamer.__test.registeredProjectCount()).toBe(1);
			const opts = registrations.at(-1);
			if (!opts) throw new Error("project maintenance was not registered");
			expect(opts.config.disable).toBe(disable);
			expect(opts.gitCommitIndexing).toEqual({
				enabled: true,
				since_days: 17,
				max_commits: 173,
			});
			expect(opts.sampleDreamRun?.().gitCommitIndexing).toEqual(
				opts.gitCommitIndexing,
			);
		} finally {
			register.mockRestore();
			await handlers.get("session_shutdown")?.(
				{},
				{ cwd: root, sessionManager: { getSessionId: () => undefined } },
			);
		}
	});
}
