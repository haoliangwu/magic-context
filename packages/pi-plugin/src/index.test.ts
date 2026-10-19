import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	changedLiveKeys,
	historianRunConfig,
} from "@magic-context/core/config/live-run-config";
import { LiveConfigReader } from "@magic-context/core/config/live-snapshot";
import { MagicContextConfigSchema } from "@magic-context/core/config/schema/magic-context";
import * as loggerModule from "@magic-context/core/shared/logger";
import { closeQuietly } from "@magic-context/core/shared/sqlite-helpers";
import { createTestTempDirFromPath } from "@magic-context/core/shared/test-temp-dir";
import {
	__test,
	registerConfiguredTodoLifecycle,
	resolveHistorianFromConfig,
} from "./index";
import { buildPiHistorianCommandOptions } from "./pi-historian-command-options";
import { createTestDb } from "./test-utils.test";
import { registerMagicContextTools } from "./tools";

describe("Pi recomp and wrapup historian output-cap config", () => {
	it("resolves configured and unset caps using the historian config", () => {
		const configured = MagicContextConfigSchema.parse({
			historian: { maxTokens: 65_536, pi: { model: "provider/model" } },
		});
		const unset = MagicContextConfigSchema.parse({
			historian: { pi: { model: "provider/model" } },
		});

		expect(resolveHistorianFromConfig(configured, "pi")?.maxOutputTokens).toBe(
			65_536,
		);
		expect(
			resolveHistorianFromConfig(unset, "pi")?.maxOutputTokens,
		).toBeUndefined();
	});

	it("uses boot and refreshed historian caps for both harnesses", () => {
		for (const harness of ["pi", "omp"] as const) {
			const root = createTestTempDirFromPath(
				join(tmpdir(), `mc-pi-historian-command-${harness}-`),
			);
			const previousHome = process.env.HOME;
			const previousConfigHome = process.env.XDG_CONFIG_HOME;
			process.env.HOME = root;
			process.env.XDG_CONFIG_HOME = join(root, "config");
			const directory = join(root, "project");
			const userConfigDirectory = join(root, "config", "cortexkit");
			mkdirSync(directory, { recursive: true });
			mkdirSync(userConfigDirectory, { recursive: true });
			const configPath = join(userConfigDirectory, "magic-context.jsonc");
			const configFor = (maxTokens?: number) =>
				MagicContextConfigSchema.parse({
					historian: {
						...(maxTokens === undefined ? {} : { maxTokens }),
						[harness]: { model: `provider/${harness}-historian` },
					},
				});
			try {
				let fresh = configFor(4096);
				const boot = fresh;
				writeFileSync(configPath, JSON.stringify(fresh));
				const reader = new LiveConfigReader(
					directory,
					boot,
					() => fresh,
					() => {},
					changedLiveKeys,
				);
				reader.poll();
				const optionsFor = (effective: typeof boot) =>
					buildPiHistorianCommandOptions(
						resolveHistorianFromConfig(
							historianRunConfig(boot, effective),
							harness,
						),
						boot,
					);

				const bootOptions = optionsFor(reader.current().effective);
				expect(bootOptions.historianMaxOutputTokens).toBe(4096);

				fresh = configFor(65_536);
				writeFileSync(configPath, JSON.stringify(fresh));
				const liveOptions = optionsFor(reader.poll().effective);
				expect(liveOptions.historianMaxOutputTokens).toBe(65_536);
				expect(bootOptions.historianMaxOutputTokens).toBe(4096);

				fresh = configFor();
				writeFileSync(configPath, JSON.stringify(fresh));
				const unsetOptions = optionsFor(reader.poll().effective);
				expect(unsetOptions.historianMaxOutputTokens).toBeUndefined();
			} finally {
				if (previousHome === undefined) delete process.env.HOME;
				else process.env.HOME = previousHome;
				if (previousConfigHome === undefined)
					delete process.env.XDG_CONFIG_HOME;
				else process.env.XDG_CONFIG_HOME = previousConfigHome;
				rmSync(root, { recursive: true, force: true });
			}
		}
	});
});

describe("Pi todowrite registration from resolved config", () => {
	it.each([
		undefined,
		true,
		false,
	])("registers tool, command and overlay only when enabled is %s", (enabled) => {
		const config = MagicContextConfigSchema.parse(
			enabled === undefined ? {} : { todowrite: { enabled } },
		);
		const db = createTestDb();
		try {
			const tools: string[] = [];
			const commands: string[] = [];
			const handlers: string[] = [];
			const pi = {
				registerTool: (tool: { name: string }) => tools.push(tool.name),
				registerCommand: (name: string) => commands.push(name),
				on: (name: string) => handlers.push(name),
			} as never;
			registerMagicContextTools(pi, {
				db,
				todowriteEnabled: config.todowrite.enabled,
			});
			const overlay = registerConfiguredTodoLifecycle(pi, {
				configured: config.todowrite.enabled,
				overlay: config.todowrite.overlay,
				readLastTodoState: () => "",
			});
			expect(tools.includes("todowrite")).toBe(enabled === true);
			expect(commands.includes("todos")).toBe(enabled === true);
			expect(overlay !== undefined).toBe(enabled === true);
			expect(handlers.includes("session_start")).toBe(enabled === true);
		} finally {
			closeQuietly(db);
		}
	});
});

afterEach(() => {
	__test.resetLoggedPiConfigDirs();
});

describe("Pi config load logging", () => {
	it("dedupes /cd config warnings per directory", () => {
		const logSpy = spyOn(loggerModule, "log").mockImplementation(
			() => undefined,
		);
		try {
			__test.logPiConfigLoad({
				dir: "/tmp/project-a",
				loadedFromPaths: ["/tmp/project-a/.cortexkit/magic-context.jsonc"],
				warnings: ["Ignoring historian.model from project config"],
				dedupe: true,
			});
			__test.logPiConfigLoad({
				dir: "/tmp/project-a",
				loadedFromPaths: ["/tmp/project-a/.cortexkit/magic-context.jsonc"],
				warnings: ["Ignoring historian.model from project config"],
				dedupe: true,
			});
			__test.logPiConfigLoad({
				dir: "/tmp/project-b",
				loadedFromPaths: [],
				warnings: ["Ignoring execute_threshold_percentage from project config"],
				dedupe: true,
			});

			const messages = logSpy.mock.calls.map(([message]) => String(message));
			expect(
				messages.filter((message) => message.includes("config loaded from:")),
			).toHaveLength(1);
			expect(
				messages.filter((message) =>
					message.includes(
						"config: no magic-context.jsonc found, using schema defaults",
					),
				),
			).toHaveLength(1);
			expect(
				messages.filter((message) =>
					message.includes("Ignoring historian.model from project config"),
				),
			).toHaveLength(1);
			expect(
				messages.filter((message) =>
					message.includes(
						"Ignoring execute_threshold_percentage from project config",
					),
				),
			).toHaveLength(1);
		} finally {
			logSpy.mockRestore();
		}
	});

	it("surfaces the protected_tokens below-minimum warning through the config load log", () => {
		const logSpy = spyOn(loggerModule, "log").mockImplementation(
			() => undefined,
		);
		try {
			__test.logPiConfigLoad({
				dir: "/tmp/project-belowmin",
				loadedFromPaths: [
					"/tmp/project-belowmin/.cortexkit/magic-context.jsonc",
				],
				warnings: [
					"protected_tokens is a token floor (minimum 4000, default derived from the context window); 20 looks like the old protected_tags count. Remove the key to use the default, or set a token count such as 16000.",
				],
				dedupe: true,
			});

			const messages = logSpy.mock.calls.map(([message]) => String(message));
			expect(
				messages.some((message) =>
					message.includes("protected_tokens is a token floor"),
				),
			).toBe(true);
			expect(
				messages.some((message) =>
					message.includes("20 looks like the old protected_tags count"),
				),
			).toBe(true);
		} finally {
			logSpy.mockRestore();
		}
	});
});

describe("Pi deferred compaction marker rehydration logging", () => {
	it("names sessions, caps the list, and reports active-session membership", () => {
		expect(
			__test.formatPiMarkerRehydrationLine(["active", "other"], "active"),
		).toBe(
			"[magic-context][pi] rehydrated 2 Pi deferred compaction marker session(s); sessionIds=active,other; activeSessionIncluded=true",
		);
		const many = Array.from({ length: 7 }, (_, index) => `session-${index}`);
		expect(__test.formatPiMarkerRehydrationLine(many, "not-listed")).toBe(
			"[magic-context][pi] rehydrated 7 Pi deferred compaction marker session(s); sessionIds=session-0,session-1,session-2,session-3,session-4 +2 more; activeSessionIncluded=false",
		);
	});
});
