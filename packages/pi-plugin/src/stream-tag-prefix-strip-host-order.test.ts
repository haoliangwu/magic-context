/**
 * Pins the Pi host behaviour the stream tag-prefix rewrite depends on.
 *
 * `stream-tag-prefix-strip.ts` hides the model's leading `§N§ ` from Pi's live
 * stream by editing the `message_update` event inside an extension handler.
 * Pi's extension API gives that handler no rewrite result, so the edit reaches
 * Pi's JSON/RPC writer only because Pi's `AgentSession` runs extension handlers
 * before it notifies public listeners, and hands both the same event objects.
 *
 * Each case below boots a real `AgentSession` of one installed Pi version with
 * the rewrite registered as an inline extension, replaces only the provider
 * stream with a scripted one, and serializes every public event exactly as
 * Pi's JSON mode does (`toJsonEvent` → `JSON.stringify`). If a Pi update clones
 * the event before extensions or notifies listeners first, the prefix comes
 * back on the wire and these tests fail.
 */
import { describe, expect, it } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import * as pi087 from "pi-coding-agent-087";
import * as pi130 from "pi-coding-agent-130";
import { createTestTempDir } from "../../plugin/src/shared/test-temp-dir";
import { registerStreamTagPrefixStrip } from "./stream-tag-prefix-strip";

/** The parts of a Pi coding-agent module these tests use; both versions export them. */
interface PiModule {
	createAgentSession: typeof pi087.createAgentSession;
	DefaultResourceLoader: typeof pi087.DefaultResourceLoader;
	ModelRuntime: typeof pi087.ModelRuntime;
	SessionManager: typeof pi087.SessionManager;
	SettingsManager: typeof pi087.SettingsManager;
}

const PROVIDER = "anthropic";

/** A provider stream that, like Pi's real providers, appends to one message object. */
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
	const iterator = events();
	return Object.assign(iterator, { result: async () => output });
}

interface RunResult {
	/** Every public `message_update` frame as Pi's JSON mode would write it. */
	wireFrames: Array<Record<string, unknown>>;
	/** Text of the in-process `message_update` snapshots (`message` and `partial`), in order. */
	snapshotTexts: string[];
	/** Assistant text of the finished message Pi keeps in the session. */
	finalText: string | undefined;
}

function textOf(message: unknown): string | undefined {
	const parts = (message as { content?: unknown } | undefined)?.content;
	if (!Array.isArray(parts)) return undefined;
	return parts.map((part) => (part as { text?: string }).text ?? "").join("");
}

async function runScriptedReply(
	pi: PiModule,
	toJsonEvent: (event: unknown) => unknown,
	deltas: string[],
): Promise<RunResult> {
	const { dir: root, cleanup } = createTestTempDir(
		"mc-pi-test-xdg-",
		"stream-prefix",
	);
	const agentDir = join(root, "agent");
	const cwd = join(root, "workspace");
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(cwd, { recursive: true });
	// Pi falls back to this variable (default ~/.pi/agent) for anything not
	// given an explicit path; point it at the throwaway root too.
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	try {
		const settingsManager = pi.SettingsManager.inMemory({
			compaction: { enabled: false },
		});
		const modelRuntime = await pi.ModelRuntime.create({
			authPath: join(agentDir, "auth.json"),
			modelsPath: join(agentDir, "models.json"),
		});
		await modelRuntime.setRuntimeApiKey(PROVIDER, "test-key");
		const model = modelRuntime.getModel(PROVIDER, "claude-sonnet-4-5");
		if (!model) throw new Error("built-in test model missing");

		const resourceLoader = new pi.DefaultResourceLoader({
			cwd,
			agentDir,
			settingsManager,
			noExtensions: true,
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
			extensionFactories: [
				(api) => {
					registerStreamTagPrefixStrip(api as never, () => true);
				},
			],
		});
		await resourceLoader.reload();

		const { session } = await pi.createAgentSession({
			cwd,
			agentDir,
			model,
			thinkingLevel: "off",
			modelRuntime,
			resourceLoader,
			noTools: "all",
			sessionManager: pi.SessionManager.inMemory(cwd),
			settingsManager,
		});
		// Only the provider is replaced; the agent loop, session and extension
		// runner are Pi's own.
		session.agent.streamFunction = (async () =>
			scriptedStream(model, deltas)) as never;

		const wireFrames: Array<Record<string, unknown>> = [];
		const snapshotTexts: string[] = [];
		session.subscribe((event) => {
			if (event.type !== "message_update") return;
			wireFrames.push(JSON.parse(JSON.stringify(toJsonEvent(event))));
			for (const snapshot of [
				event.message,
				(event.assistantMessageEvent as { partial?: unknown }).partial,
			]) {
				const text = textOf(snapshot);
				if (text !== undefined) snapshotTexts.push(text);
			}
		});
		try {
			await session.prompt("hello");
			const assistant = session.messages.find(
				(message) => message.role === "assistant",
			);
			return { wireFrames, snapshotTexts, finalText: textOf(assistant) };
		} finally {
			session.dispose();
		}
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		cleanup();
	}
}

function wireDeltas(frames: Array<Record<string, unknown>>): string[] {
	return frames
		.map(
			(frame) =>
				frame.assistantMessageEvent as { type: string; delta?: string },
		)
		.filter((update) => update.type === "text_delta")
		.map((update) => update.delta ?? "");
}

function wireTextEnd(
	frames: Array<Record<string, unknown>>,
): string | undefined {
	const end = frames
		.map(
			(frame) =>
				frame.assistantMessageEvent as { type: string; content?: string },
		)
		.find((update) => update.type === "text_end");
	return end?.content;
}

const versions: Array<[string, PiModule, (event: unknown) => unknown]> = [
	[
		"Pi 0.87.1",
		pi087 as unknown as PiModule,
		await jsonEventFor("pi-coding-agent-087"),
	],
	[
		"Pi 1.3.0",
		pi130 as unknown as PiModule,
		await jsonEventFor("pi-coding-agent-130"),
	],
];

/**
 * Pi's own JSON-mode serializer for that version. It is not in the package's
 * export map, so it is loaded by file path next to the resolved entry point.
 */
async function jsonEventFor(
	packageName: string,
): Promise<(event: unknown) => unknown> {
	const entry = import.meta.resolve(packageName);
	const module = (await import(
		new URL("./modes/json-event.js", entry).href
	)) as {
		toJsonEvent?: (event: unknown) => unknown;
	};
	if (typeof module.toJsonEvent !== "function") {
		throw new Error(
			`${packageName} no longer ships modes/json-event.js#toJsonEvent`,
		);
	}
	return module.toJsonEvent;
}

for (const [label, pi, toJsonEvent] of versions) {
	describe(`stream tag-prefix rewrite on a real ${label} session`, () => {
		it("JSON frames carry the reply without the split leading prefix", async () => {
			const run = await runScriptedReply(pi, toJsonEvent, [
				"§12",
				"3§ ",
				"Hello ",
				"§9§ world",
			]);
			expect(wireDeltas(run.wireFrames).join("")).toBe("Hello §9§ world");
			expect(wireDeltas(run.wireFrames)).toEqual([
				"",
				"",
				"Hello ",
				"§9§ world",
			]);
			expect(wireTextEnd(run.wireFrames)).toBe("Hello §9§ world");
			// In-process snapshots never show the prefix next to the stripped deltas.
			for (const text of run.snapshotTexts)
				expect(text.startsWith("§123§")).toBe(false);
			// The finished message is the provider's own; this test registers only
			// the stream rewrite (not the message_end strip), so it must still hold
			// the model's raw text: the rewrite never edits the provider's message.
			expect(run.finalText).toBe("§123§ Hello §9§ world");
		});

		it("a reply without a prefix streams every delta unchanged", async () => {
			const run = await runScriptedReply(pi, toJsonEvent, ["Hi", " there"]);
			expect(wireDeltas(run.wireFrames)).toEqual(["Hi", " there"]);
			expect(wireTextEnd(run.wireFrames)).toBe("Hi there");
		});
	});
}
