import { afterAll, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	cleanupTestTempDir,
	createTestTempDirFromPath,
} from "@magic-context/core/shared/test-temp-dir";
import {
	exerciseOmpLoggerFiles,
	pinOmpLoggerFiles,
	reportOmpLogDescriptors,
} from "./__tests__/omp-log-files";

// OMP reads its configuration paths while importing the extension runner.
const parent = join(tmpdir(), "magic-context", "issue-766");
mkdirSync(parent, { recursive: true });
const root = createTestTempDirFromPath(join(parent, "two-phase-replay-"));
const environment = {
	HOME: join(root, "home"),
	XDG_CONFIG_HOME: join(root, "config"),
	XDG_DATA_HOME: join(root, "data"),
	XDG_CACHE_HOME: join(root, "cache"),
	XDG_STATE_HOME: join(root, "state"),
	PI_CODING_AGENT_DIR: join(root, "agent"),
	MAGIC_CONTEXT_STORAGE_DIR: join(root, "storage"),
};
const previous = Object.fromEntries(
	Object.keys(environment).map((key) => [key, process.env[key]]),
);
for (const [key, value] of Object.entries(environment)) {
	mkdirSync(value, { recursive: true });
	process.env[key] = value;
}
const ompLoggerAliases = ["omp-pi-ai-1812", "omp-coding-agent-1812"];
await pinOmpLoggerFiles(root, ompLoggerAliases);
const require = createRequire(import.meta.url);
const ai = require.resolve("omp-pi-ai-1812/package.json").slice(0, -12);
const agent = require
	.resolve("omp-coding-agent-1812/package.json")
	.slice(0, -12);
const { buildResponsesInput } = await import(
	`${ai}src/providers/openai-shared.ts`
);
const { ExtensionRunner } = await import(
	`${agent}src/extensibility/extensions/runner.ts`
);
const { registerOmpAssistantMessageStrip } = await import("./strip-tag-prefix");
const { piPreparedStructure, piPreparedStructureMismatch } = await import(
	"./pi-dispatch-structure"
);
await exerciseOmpLoggerFiles(ompLoggerAliases);
reportOmpLogDescriptors();

afterAll(() => {
	for (const [key, value] of Object.entries(previous)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	cleanupTestTempDir(root);
});

test("Codex saved replay admits unsigned final_answer and commentary rows after the real OMP rewrite", async () => {
	const target = {
		api: "openai-codex-responses",
		id: "gpt-6-luna",
		provider: "openai",
		input: ["text"],
		compat: {},
		identity: { class: "gpt", model: "gpt-6-luna" },
	};
	const rows = [
		{
			id: "msg_final",
			phase: "final_answer",
			raw: "§12§ Hello",
			text: "Hello",
		},
		{
			id: "msg_comment",
			phase: "commentary",
			raw: "§13§ Working",
			text: "Working",
		},
	];
	const message = {
		role: "assistant",
		api: target.api,
		model: target.id,
		provider: target.provider,
		timestamp: 1,
		stopReason: "stop",
		content: rows.map((row) => ({
			type: "text",
			text: row.raw,
			textSignature: JSON.stringify({ v: 1, id: row.id, phase: row.phase }),
		})),
		providerPayload: {
			type: "openaiResponsesHistory",
			provider: target.provider,
			dt: true,
			items: rows.map((row) => ({
				type: "message",
				role: "assistant",
				id: row.id,
				phase: row.phase,
				status: "completed",
				content: [{ type: "output_text", text: row.raw, annotations: [] }],
			})),
		},
	};
	const handlers = new Map();
	registerOmpAssistantMessageStrip(
		{ on: (name: string, fn: unknown) => handlers.set(name, [fn]) },
		() => true,
	);
	const runner = new ExtensionRunner(
		[{ path: "strip", handlers }],
		{},
		root,
		{},
		{},
	);
	// The real runner validates the rewrite and removes signatures; unused UI is stubbed.
	runner.createContext = () => ({ ui: {} });
	runner.onError((error: unknown) => {
		throw new Error(JSON.stringify(error));
	});
	const content = await runner.emitAssistantMessage(message);
	expect(content).toEqual(
		rows.map((row) => ({ type: "text", text: row.text })),
	);
	const saved = JSON.parse(JSON.stringify({ ...message, content }));
	expect(
		saved.content.every(
			(block: { textSignature?: string }) => block.textSignature === undefined,
		),
	).toBe(true);
	expect(saved.providerPayload).toEqual(message.providerPayload);
	const messages = [
		{ role: "user", content: [{ type: "text", text: "hello" }], timestamp: 0 },
		saved,
	];
	const input = buildResponsesInput({
		model: target,
		context: { messages },
		strictResponsesPairing: false,
		supportsImageDetailOriginal: false,
		nativeHistory: { replay: true, filterReasoning: false },
	});
	expect(input.slice(1).map((row: { phase: string }) => row.phase)).toEqual([
		"final_answer",
		"commentary",
	]);
	expect(
		input
			.slice(1)
			.map((row: { content: { text: string }[] }) => row.content[0].text),
	).toEqual(["§12§ Hello", "§13§ Working"]);
	const prepared = piPreparedStructure(messages, target, "omp");
	expect(piPreparedStructureMismatch({ input }, prepared)).toBeUndefined();
	expect(
		piPreparedStructureMismatch({ type: "response.create", input }, prepared),
	).toBeUndefined();
});
