import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { __setMigrationWorkerEntryForTests } from "@magic-context/core/features/magic-context/migration-worker-client";
import { getMainThreadMigrationBodyCount } from "@magic-context/core/features/magic-context/migrations";
import { closeDatabase } from "@magic-context/core/features/magic-context/storage-db";
import { createTestTempDir } from "../../plugin/src/shared/test-temp-dir";
import extension from "./index";
import { contextHost } from "./pi-context-host.test";

let root: string, originalCwd: string, originalEnv: NodeJS.ProcessEnv;
beforeEach(() => {
	originalEnv = { ...process.env };
	originalCwd = process.cwd();
	root = createTestTempDir("pi-worker-refusal-").dir;
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
	closeDatabase();
	__setMigrationWorkerEntryForTests(
		pathToFileURL(join(root, "missing-worker.mjs")),
	);
});
afterEach(() => {
	__setMigrationWorkerEntryForTests(null);
	closeDatabase();
	process.chdir(originalCwd);
	process.env = originalEnv;
	rmSync(root, { recursive: true, force: true });
});

test("Pi extension boot refuses an unloadable migration worker and aborts the real context runner", async () => {
	const host = contextHost();
	const handlers = new Map<string, ((...args: never[]) => unknown)[]>();
	const pi = {
		...host.api,
		events: { on: () => () => {} },
		on: (name: string, handler: (...args: never[]) => unknown) => {
			const list = handlers.get(name) ?? [];
			list.push(handler);
			handlers.set(name, list);
		},
		getAllTools: () => [],
	};
	const before = getMainThreadMigrationBodyCount();
	await extension(pi as never);
	expect(getMainThreadMigrationBodyCount()).toBe(before);
	const context = handlers.get("context")?.[0];
	expect(context).toBeDefined();
	const raw = [
		{ role: "user", content: "unmanaged must not send", timestamp: 1 },
	];
	if (!context)
		throw new Error("Pi did not install its fail-closed context surface");
	const served = await host.emit(context, raw, {});
	host.assertRefused(served, raw);
	expect(getMainThreadMigrationBodyCount()).toBe(before);
});
