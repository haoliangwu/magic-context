import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { OpenCode } from "@opencode/client";
import { MockProvider } from "../../src/mock-provider/server";
import {
	inspectOpenFiles,
	isolation,
	readPluginLog,
	spawnOpencode2,
	waitForPluginActive,
} from "../../src/opencode2-runner/spawn";

const MODEL = "claude-sonnet-5-5";
const MARKER = "SIGNED-DROP-REBUILD";
const bytes = (value: unknown) =>
	JSON.stringify(value, (key, item) =>
		key === "cache_control" ? undefined : item,
	);
const thinking = (step: number) => ({
	type: "thinking",
	thinking: `Reason ${step}`,
	signature: `signed-${step}`,
});
type WireMessage = { role: string; content: Array<{ type: string }> };

test("OC2 signed tool loop holds queued drops on a plain real-user pass until ctx-flush", async () => {
	const fixture = isolation();
	const mock = new MockProvider();
	const provider = await mock.start({
		thinkingScope: (body) =>
			bytes(body.messages).includes(MARKER) ? MARKER : undefined,
	});
	const host = await spawnOpencode2({
		existingIsolation: fixture,
		existingMock: { mock, baseURL: provider.baseURL },
		providerID: "anthropic",
		defaultModelID: MODEL,
		modelContextLimit: 100_000,
		modelOutputLimit: 1024,
		compactionAuto: false,
		magicContextConfig: {
			execute_threshold_tokens: { default: 5000 },
			protected_tokens: 4000,
			dreamer: { disable: true },
			memory: { enabled: false },
		},
	});
	const client = OpenCode.make({
		baseUrl: host.url,
		headers: { authorization: `Basic ${btoa(`opencode:${host.password}`)}` },
	});
	const db = new Database(
		join(host.env.MAGIC_CONTEXT_STORAGE_DIR!, "context.db"),
	);
	db.exec("PRAGMA busy_timeout = 10000");
	let step = 0;
	let tag = 0;
	const wire: WireMessage[][] = [];
	try {
		const session = await client.session.create({
			title: "signed drop rebuild",
			location: { directory: host.cwd },
			model: { providerID: "anthropic", id: MODEL },
		});
		await waitForPluginActive(client, host.cwd);
		const databases = inspectOpenFiles(host.pid!, host.root, host.env).filter(
			(path) => /\.(?:db|sqlite)(?:-(?:wal|shm))?$/.test(path),
		);
		expect(databases.length).toBeGreaterThan(0);
		expect(databases.every((path) => path.startsWith(host.root + "/"))).toBe(
			true,
		);
		for (const name of ["a", "b", "c"])
			writeFileSync(
				join(host.cwd, `${name}.txt`),
				`SPENT-${name}\n` +
					Array.from(
						{ length: 2000 },
						(_, n) => `${n * 7919}:${n * 3571}!`,
					).join(" "),
			);
		mock.addMatcher((body) => {
			if (
				!bytes(body.messages).includes(MARKER) ||
				!(body.tools as Array<{ name: string }> | undefined)?.some(
					(tool) => tool.name === "shell",
				)
			)
				return null;
			step++;
			wire.push(structuredClone(body.messages as WireMessage[]));
			const usage = {
				input_tokens: 0,
				output_tokens: 20,
				cache_read_input_tokens:
					step >= 4 ? Math.ceil(0.76 * (100_000 - 1024)) : 100,
				cache_creation_input_tokens: 0,
			};
			const tool = (name: string, input: unknown) => ({
				content: [
					thinking(step),
					{ type: "tool_use", id: `call-${step}`, name, input },
				],
				stop_reason: "tool_use" as const,
				usage,
			});
			if (step <= 3)
				return tool("shell", {
					command: `cat ${["a", "b", "c"][step - 1]}.txt`,
					description: "Read spent output",
				});
			if (step === 6) {
				const tags = db
					.query(
						"SELECT tag_number FROM tags WHERE session_id = ? AND type = 'tool' AND status = 'active' ORDER BY tag_number",
					)
					.all(session.id) as Array<{ tag_number: number }>;
				tag = tags[1]!.tag_number;
				return tool("ctx_reduce", { drop: String(tag) });
			}
			if (step < 9)
				return tool("shell", {
					command: "printf continue",
					description: "Continue the signed tool loop",
				});
			return { text: "Loop done", usage };
		});
		mock.setDefault({
			text: "fixture reply",
			usage: { input_tokens: 100, output_tokens: 10 },
		});
		const prompt = async (text: string) => {
			await client.session.prompt({ sessionID: session.id, text });
			await client.session.wait(
				{ sessionID: session.id },
				{ signal: AbortSignal.timeout(90_000) },
			);
		};
		const pending = () =>
			db
				.query("SELECT tag_id FROM pending_ops WHERE session_id = ?")
				.all(session.id);
		await prompt(`${MARKER} run the tool loop`);
		expect(step).toBe(9);
		expect(mock.requests().some((request) => request.thinkingViolation)).toBe(
			false,
		);
		expect(pending()).toContainEqual({ tag_id: tag });
		const previous = wire.at(-1)!;
		const lastRequest = () =>
			mock
				.requests()
				.filter(
					(request) =>
						bytes(request.body.messages).includes(MARKER) &&
						(request.body.tools as Array<{ name: string }> | undefined)?.some(
							(tool) => tool.name === "shell",
						),
				)
				.at(-1)!.body;
		const previousBody = lastRequest();
		const logOffset = readPluginLog(host.env).length;
		await prompt("Next real user turn; finish.");
		const held = wire.at(-1)!;
		// A real user ends the signed turn, but does not pay for a prefix rewrite.
		expect(bytes(held.slice(0, previous.length))).toBe(bytes(previous));
		expect(bytes(lastRequest().system)).toBe(bytes(previousBody.system));
		expect(bytes(lastRequest().tools)).toBe(bytes(previousBody.tools));
		expect(bytes(held)).toContain("SPENT-b");
		expect(
			held
				.flatMap((message) => message.content)
				.filter((part) => part.type === "thinking"),
		).toEqual(Array.from({ length: 8 }, (_, n) => thinking(n + 1)));
		expect(pending()).toContainEqual({ tag_id: tag });
		// The plugin buffers log writes for up to half a second, so poll the part of
		// the log written after this turn began instead of reading it once. An earlier
		// pass of the tool loop can log the same line, so only the new part counts.
		const holdLine =
			"pending ops held — reason=no originating cache-bust opportunity; scheduler=execute, historianRunning=false";
		let sinceTurn = "";
		for (const deadline = Date.now() + 5_000; ; ) {
			sinceTurn = readPluginLog(host.env).slice(logOffset);
			if (sinceTurn.includes(holdLine) || Date.now() >= deadline) break;
			await new Promise((resolveWait) => setTimeout(resolveWait, 100));
		}
		expect(sinceTurn).toContain(holdLine);
		// The public flush command grants the same permission as a genuine rebuild.
		await client.session.command({
			sessionID: session.id,
			name: "ctx-flush",
			text: "",
		});
		await prompt("Apply the explicitly requested rebuild; finish.");
		expect(bytes(wire.at(-1))).not.toContain("SPENT-b");
		expect(pending()).toHaveLength(0);
	} finally {
		db.close();
		await host.stop();
	}
}, 180_000);
