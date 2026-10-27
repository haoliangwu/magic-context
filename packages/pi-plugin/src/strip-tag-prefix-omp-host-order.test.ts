/**
 * Pins how Magic Context strips the model's leading `§N§` tag from the reply
 * Oh My Pi saves.
 *
 * Oh My Pi hands `message_end` handlers a detached copy of the message, so the
 * in-place strip that works on stock Pi changes nothing there. Its supported
 * hook for editing a finished assistant message is `assistant_message`, which
 * runs before the message reaches `message_end` listeners and persistence.
 *
 * Each case boots a real Oh My Pi 18.12.3 `AgentSession` with one inline
 * extension, replaces only the provider stream with a scripted one, and reads
 * back the saved session entry and the public `message_end` frame.
 */
import { afterAll, describe, expect, it } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { stripPersistedAssistantText } from "@magic-context/core/hooks/magic-context/tag-content-primitives";
import { createTestTempDir } from "../../plugin/src/shared/test-temp-dir";
import {
	exerciseOmpLoggerFiles,
	pinOmpLoggerFiles,
	reportOmpLogDescriptors,
} from "./__tests__/omp-log-files";
import {
	registerOmpAssistantMessageStrip,
	stripTagPrefixFromAssistantMessage,
} from "./strip-tag-prefix";

// Oh My Pi reads its home, agent and data directories from the environment,
// some of them at import time, so the whole run is pointed at a throwaway root
// before the package is loaded.
const { dir: root, cleanup } = createTestTempDir(
	"mc-pi-test-xdg-",
	"omp-assistant-message",
);
const agentDir = join(root, "agent");
const cwd = join(root, "workspace");
for (const dir of [agentDir, cwd, join(root, "home")])
	mkdirSync(dir, { recursive: true });
const ENV_KEYS = [
	"HOME",
	"XDG_DATA_HOME",
	"XDG_CONFIG_HOME",
	"XDG_STATE_HOME",
	"XDG_CACHE_HOME",
	"PI_CODING_AGENT_DIR",
	"ANTHROPIC_API_KEY",
] as const;
const previousEnv = Object.fromEntries(
	ENV_KEYS.map((key) => [key, process.env[key]]),
);
process.env.HOME = join(root, "home");
process.env.XDG_DATA_HOME = join(root, "home", ".local", "share");
process.env.XDG_CONFIG_HOME = join(root, "home", ".config");
process.env.XDG_STATE_HOME = join(root, "home", ".local", "state");
process.env.XDG_CACHE_HOME = join(root, "home", ".cache");
process.env.PI_CODING_AGENT_DIR = agentDir;
// Never sent anywhere: the provider stream below is scripted.
process.env.ANTHROPIC_API_KEY = "test-key";

afterAll(() => {
	for (const key of ENV_KEYS) {
		const value = previousEnv[key];
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	cleanup();
});

// Loaded by a non-literal name so TypeScript does not pull Oh My Pi's own type
// declarations into this package's typecheck; the module is used untyped.
const OMP_PACKAGE = "omp-coding-agent-1812";
const ompLoggerAliases = ["omp-pi-ai-1812", OMP_PACKAGE];
await pinOmpLoggerFiles(root, ompLoggerAliases);
const omp = await import(OMP_PACKAGE);
await exerciseOmpLoggerFiles(ompLoggerAliases);
reportOmpLogDescriptors();

type ExtensionFactory = (api: unknown) => void;

/** A provider stream that, like the real providers, appends to one message object. */
function scriptedStream(
	model: { api: string; provider: string; id: string },
	deltas: string[],
) {
	const output = {
		role: "assistant" as const,
		content: [] as Array<{ type: "text"; text: string }>,
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop" as const,
		timestamp: Date.now(),
	};
	async function* events() {
		yield { type: "start", partial: output };
		output.content.push({ type: "text", text: "" });
		yield { type: "text_start", contentIndex: 0, partial: output };
		for (const delta of deltas) {
			output.content[0].text += delta;
			yield { type: "text_delta", contentIndex: 0, delta, partial: output };
		}
		yield {
			type: "text_end",
			contentIndex: 0,
			content: output.content[0].text,
			partial: output,
		};
		yield { type: "done", reason: "stop", message: output };
	}
	return Object.assign(events(), { result: async () => output });
}

function textOf(message: unknown): string | undefined {
	const parts = (message as { content?: unknown } | undefined)?.content;
	if (!Array.isArray(parts)) return undefined;
	return parts.map((part) => (part as { text?: string }).text ?? "").join("");
}

/** Run one scripted reply; return the saved assistant text and the public message_end text. */
async function runReply(extension: ExtensionFactory, deltas: string[]) {
	const settings = omp.Settings.isolated({});
	const authStorage = await omp.discoverAuthStorage(agentDir, {
		settings,
		cwd,
	});
	const modelRegistry = new omp.ModelRegistry(
		authStorage,
		join(agentDir, "models.yml"),
		{ settings },
	);
	const model = modelRegistry.find("anthropic", "claude-sonnet-4-5");
	if (!model) throw new Error("bundled test model missing");
	const sessionManager = omp.SessionManager.inMemory(cwd);
	const { session } = await omp.createAgentSession({
		cwd,
		agentDir,
		model,
		authStorage,
		modelRegistry,
		settings,
		sessionManager,
		extensions: [extension],
		disableExtensionDiscovery: true,
		enableMCP: false,
		enableLsp: false,
		hasUI: false,
		skills: [],
		rules: [],
		contextFiles: [],
		promptTemplates: [],
		toolNames: [],
	});
	// Only the provider is replaced; the agent loop, session, extension runner
	// and persistence are Oh My Pi's own.
	session.agent.streamFn = async () => scriptedStream(model, deltas);
	const endFrames: string[] = [];
	session.subscribe((event: { type: string; message?: { role?: string } }) => {
		if (event.type === "message_end" && event.message?.role === "assistant") {
			endFrames.push(textOf(event.message) ?? "");
		}
	});
	try {
		await session.prompt("hello");
		const saved = (
			sessionManager.getEntries() as Array<{
				type: string;
				message?: { role?: string };
			}>
		)
			.filter(
				(entry) =>
					entry.type === "message" && entry.message?.role === "assistant",
			)
			.map((entry) => textOf(entry.message));
		return { saved, endFrames };
	} finally {
		await session.dispose();
	}
}

const DELTAS = ["§12", "3§ ", "Hello ", "§9§ world"];
const RAW = "§123§ Hello §9§ world";

describe("tag-prefix strip on a real Oh My Pi 18.12.3 session", () => {
	it("assistant_message strips the saved reply with the message_end rule", async () => {
		const run = await runReply(
			(api) => registerOmpAssistantMessageStrip(api, () => true),
			DELTAS,
		);
		expect(run.saved).toEqual([stripPersistedAssistantText(RAW)]);
		expect(run.endFrames).toEqual([stripPersistedAssistantText(RAW)]);
	});

	it("an in-place message_end strip does not reach what Oh My Pi saves", async () => {
		// Why the assistant_message hook is needed: Oh My Pi gives message_end
		// handlers a detached copy. If a later Oh My Pi stops detaching it, this
		// fails and the hook choice should be revisited.
		const run = await runReply(
			(api) =>
				(
					api as {
						on(
							event: string,
							handler: (event: { message: unknown }) => void,
						): void;
					}
				).on("message_end", (event) => {
					stripTagPrefixFromAssistantMessage(
						event.message as { role: string; content: unknown },
					);
				}),
			DELTAS,
		);
		expect(run.saved).toEqual([RAW]);
	});
});
