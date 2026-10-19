import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { OpenCode } from "@opencode/client";
import { type RpcPortFileRecord, rpcPortDir } from "../../../plugin/src/shared/rpc-utils";
import {
	anthropicViolation,
	emptyTextBlock,
	type WireMessage,
} from "../../src/anthropic-request-validator";
import type { MockResponse } from "../../src/mock-provider/server";
import { createE2ETempDir } from "../../src/temp-dir";
import {
	isolation,
	readPluginLog,
	spawnOpencode2,
	waitForPluginActive,
} from "../../src/opencode2-runner/spawn";

/**
 * Magic Context must never hand OpenCode 2 an empty text block that the host
 * forwards to Anthropic (issue 662). OpenCode 2's Anthropic lowering drops empty
 * text in user and assistant messages, but it sends an in-conversation `system`
 * message (a native system update, used for Opus 4.8 and Claude 5 models) as is.
 * When Magic Context neutralized such a row to an empty sentinel, the API
 * answered every request from then on with HTTP 400 `text content blocks must
 * be non-empty`.
 *
 * A plugin listed ahead of Magic Context puts a `system` row into the draft,
 * the way another user plugin does. One session's row is only a drop marker
 * (`[dropped]`); the other's is a `<system-reminder>`, which Magic Context's
 * heuristic cleanup replaces with a drop marker. A message that holds nothing
 * but drop markers is then "neutralized" (its content replaced as a whole) on
 * the first pass that is allowed to change already-sent bytes (a rebuilding
 * pass; the first pass of a session is one). Every later pass repeats that
 * saved decision, so the request prefix stays the same. The second session
 * also gets a `/ctx-flush` call, which makes its next pass a rebuilding pass;
 * there old signed thinking is cleared (`keep_reasoning_tokens: 0`), which
 * replaces thinking parts in assistant messages with empty text parts that the
 * host must drop. The mock answers like Anthropic does: any empty text block,
 * or a system message not following a user turn, gets a 400.
 */

// OpenCode 2 sends a `system` row to these Claude models (Opus >= 4.8, every
// Claude 5) as its own in-conversation system message; older models get it
// wrapped into the user turn as text, which would hide the empty block.
const MODEL = "claude-opus-5-5";
const MARKER_ROW = "[dropped]";
const REMINDER_ROW = "<system-reminder>Background task bg_42 finished.</system-reminder>";
const TURNS_BEFORE_FLUSH = 3;

function prePlugin(root: string, rowsFile: string): string {
	const plugin = join(root, "system-rows");
	mkdirSync(plugin);
	writeFileSync(
		join(plugin, "server.js"),
		`import { existsSync, readFileSync } from 'node:fs';
export default { id: 'issue-662-system-rows', async setup(context) {
    await context.session.hook('context', draft => {
        const file = ${JSON.stringify(rowsFile)};
        const rows = existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8'))[draft.sessionID] ?? []) : [];
        if (rows.length === 0) return;
        const first = draft.messages.findIndex(m => m.role === 'user');
        if (first < 0) return;
        const anchor = draft.messages[first].id ?? 'row';
        draft.messages.splice(first + 1, 0, ...rows.map((text, i) => ({
            id: anchor + '_sysrow' + i,
            role: 'system',
            content: [{ type: 'text', text }],
        })));
    });
}};`,
	);
	return plugin;
}

const stripCache = (messages: WireMessage[]) =>
	JSON.stringify(messages, (key, value) => (key === "cache_control" ? undefined : value));

test("OpenCode 2 Anthropic requests never carry an empty text block from Magic Context", async () => {
	const fixture = isolation();
	const scratch = createE2ETempDir("mc-662-");
	const rowsFile = join(scratch, "rows.json");
	const host = await spawnOpencode2({
		existingIsolation: fixture,
		providerID: "anthropic",
		defaultModelID: MODEL,
		prePlugin: prePlugin(scratch, rowsFile),
		magicContextConfig: { keep_reasoning_tokens: 0 },
	});
	const violations: string[] = [];
	try {
		const client = OpenCode.make({
			baseUrl: host.url,
			headers: { authorization: `Basic ${btoa(`opencode:${host.password}`)}` },
		});
		host.mock.addMatcher((body): MockResponse | null => {
			if (body.model !== MODEL) return null;
			const violation = anthropicViolation(body);
			if (!violation) return null;
			violations.push(violation);
			if (violations.length === 1) console.error("first violating request", JSON.stringify(body.messages));
			return { error: { status: 400, type: "invalid_request_error", message: violation } };
		});
		let step = 0;
		host.mock.addMatcher((body): MockResponse | null => {
			if (body.model !== MODEL) return null;
			step += 1;
			return {
				content: [
					{ type: "thinking", thinking: `thinking for step ${step}`, signature: `sig-${step}` },
					{ type: "text", text: `reply ${step}` },
				],
				usage: { input_tokens: 1000 + step, output_tokens: 20 },
			};
		});

		const markerSession = await client.session.create({
			title: "dropped-placeholder system row",
			location: { directory: host.cwd },
			model: { providerID: "anthropic", id: MODEL },
		});
		const reminderSession = await client.session.create({
			title: "system-injection system row",
			location: { directory: host.cwd },
			model: { providerID: "anthropic", id: MODEL },
		});
		writeFileSync(
			rowsFile,
			JSON.stringify({
				[markerSession.id]: [MARKER_ROW],
				[reminderSession.id]: [REMINDER_ROW],
			}),
		);
		await waitForPluginActive(client, host.cwd);
		const prompt = async (sessionID: string, text: string) => {
			await client.session.prompt({ sessionID, text });
			await client.session.wait({ sessionID }, { signal: AbortSignal.timeout(30_000) });
		};
		const wires = (marker: string) =>
			host.mock
				.requests()
				.filter((request) => request.body.model === MODEL)
				.filter((request) => JSON.stringify(request.body).includes(marker))
				.map((request) => request.body);

		// The marker row is neutralized on the session's first pass.
		for (let turn = 0; turn < 3; turn += 1) await prompt(markerSession.id, `marker turn ${turn}`);

		// Make the next pass a rebuilding pass (one allowed to change sent bytes)
		// with the same RPC call the /ctx-flush command makes.
		for (let turn = 0; turn < TURNS_BEFORE_FLUSH; turn += 1)
			await prompt(reminderSession.id, `reminder turn ${turn}`);
		const storageDir = join(host.env.XDG_DATA_HOME as string, "cortexkit", "magic-context");
		const directory = rpcPortDir(storageDir, host.cwd);
		const portFile = existsSync(directory)
			? readdirSync(directory).find((name) => name.startsWith("port-") && name.endsWith(".json"))
			: undefined;
		expect(portFile).toBeDefined();
		const discovery = JSON.parse(readFileSync(join(directory, portFile!), "utf8")) as RpcPortFileRecord;
		const flushed = await fetch(`http://127.0.0.1:${discovery.port}/rpc/flush`, {
			method: "POST",
			headers: { "Content-Type": "application/json", Authorization: `Bearer ${discovery.token}` },
			body: JSON.stringify({ sessionId: reminderSession.id, directory: host.cwd }),
		});
		expect(flushed.status).toBe(200);
		for (let turn = 0; turn < 3; turn += 1)
			await prompt(reminderSession.id, `after flush ${turn}`);

		// Every database the host holds open lives under this test's throwaway root.
		const open = spawnSync("lsof", ["-p", String(host.pid), "-Fn"], { encoding: "utf8" });
		const databases = open.stdout
			.split("\n")
			.filter((line) => line.startsWith("n") && /\.db(-wal|-shm)?$/.test(line))
			.map((line) => line.slice(1));
		console.log(`host ${host.pid} open databases: ${JSON.stringify(databases)}`);
		expect(databases.length).toBeGreaterThan(0);
		for (const database of databases) expect(database.startsWith(fixture.root)).toBe(true);
		expect(violations).toEqual([]);
		const all = host.mock.requests().filter((request) => request.body.model === MODEL);
		expect(all.length).toBeGreaterThan(TURNS_BEFORE_FLUSH);
		for (const request of all) expect(emptyTextBlock(request.body)).toBeNull();

		const markerWires = wires("marker turn");
		const reminderWires = wires("reminder turn");
		expect(markerWires).toHaveLength(3);
		expect(reminderWires).toHaveLength(TURNS_BEFORE_FLUSH + 3);
		// The injected system rows are absent from every request: not sent as an
		// empty system message, nor wrapped into a user turn as <system-update> text.
		for (const body of [...markerWires, ...reminderWires]) {
			expect(JSON.stringify(body)).not.toContain("bg_42");
			expect((body.messages as WireMessage[]).some((message) => message.role === "system")).toBe(false);
		}
		const beforeFlush = reminderWires.slice(0, TURNS_BEFORE_FLUSH);
		const afterFlush = reminderWires.slice(TURNS_BEFORE_FLUSH);
		// Within each series every request repeats the previous one byte for byte
		// and adds the new turn. Only the host's tail cache breakpoint moves: OpenCode
		// 2's cache policy (packages/ai cache-policy.ts, `messages: { tail: 1 }`)
		// marks the last text block of the last message, and with the system row
		// gone that is a real block instead of the empty one.
		for (const series of [markerWires, beforeFlush, afterFlush]) {
			for (let index = 1; index < series.length; index += 1) {
				const previous = series[index - 1]!.messages as WireMessage[];
				const current = series[index]!.messages as WireMessage[];
				expect(stripCache(current.slice(0, previous.length))).toBe(stripCache(previous));
			}
			for (const body of series) {
				const last = (body.messages as WireMessage[]).at(-1)!;
				const blocks = last.content as Array<{ type: string; cache_control?: unknown }>;
				expect(blocks.findLast((block) => block.type === "text")?.cache_control).toBeDefined();
			}
		}
		// Leaving the emptied row out changes the request shape once; the plugin
		// log records that once per session.
		const recorded = async (sessionID: string) => {
			const deadline = Date.now() + 15_000;
			for (;;) {
				const lines = readPluginLog(host.env)
					.split("\n")
					.filter((line) => line.includes(`[${sessionID}]`) && line.includes("v2 payload: left out"));
				if (lines.length > 0 || Date.now() > deadline) return lines;
				await Bun.sleep(100);
			}
		};
		for (const sessionID of [markerSession.id, reminderSession.id]) {
			const lines = await recorded(sessionID);
			expect(lines).toHaveLength(1);
			expect(lines[0]).toContain("left out 1 emptied messages");
		}
	} catch (error) {
		console.error(violations, host.stderr().slice(-4000));
		throw error;
	} finally {
		await host.stop();
	}
}, 240_000);
