import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { OpenCode } from "@opencode/client";
import { Database } from "../../../plugin/src/shared/sqlite";
import { gaDatabasePath, V2StoreReader } from "../../../plugin/src/v2/store-reader";
import {
	inspectOpenFiles,
	isolation,
	type OpenCode2SpawnOptions,
	spawnOpencode2,
	waitForPluginActive,
} from "../../src/opencode2-runner/spawn";

// OpenCode 2's `read` tool returns an image file as a `content` tool result: a text entry and
// a `file` entry holding the image as a data URI. The host turns that entry into a provider
// image block. The tool result must reach the provider in that form with Magic Context
// loaded too, never serialized into the tool output as base64 text, which hides the image
// from the model and fills the context with the encoded bytes.

// A 1x1 PNG the agent reads with the host's own `read` tool.
const PNG_BASE64 =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const CALL_ID = "call_read_image";
const sha = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

type Item = { type?: string; call_id?: string; output?: unknown };
type Body = { model?: string; input?: Item[] };
type Row = { type?: string; outcome?: string };

const readResult = (body: Body) =>
	(body.input ?? []).find((item) => item.type === "function_call_output" && item.call_id === CALL_ID);

/** The image block the provider receives for the read, as JSON, or undefined. */
const imageBlock = (body: Body) => {
	const output = readResult(body)?.output;
	if (!Array.isArray(output)) return undefined;
	const image = output.find((entry) => (entry as { type?: string }).type === "input_image");
	return image === undefined ? undefined : JSON.stringify(image);
};

const baseConfig = {
	historian: { disable: true },
	dreamer: { disable: true },
	memory: { enabled: false },
};

/** One host plus a turn driver whose first turn makes the model read pixel.png. */
async function readImageSession(options: OpenCode2SpawnOptions) {
	let host = await spawnOpencode2({ visionModel: true, magicContextConfig: baseConfig, ...options });
	const mock = host.mock;
	const connect = () =>
		OpenCode.make({
			baseUrl: host.url,
			headers: { authorization: `Basic ${btoa(`opencode:${host.password}`)}` },
		});
	let client = connect();
	const session = await client.session.create({
		location: { directory: host.cwd },
		model: { providerID: "openai", id: "mock-model" },
	});
	if (options.includeMagicContext !== false) await waitForPluginActive(client, host.cwd);
	const png = join(host.cwd, "pixel.png");
	writeFileSync(png, Buffer.from(PNG_BASE64, "base64"));
	let issued = false;
	mock.addMatcher((body) => {
		if (body.model !== "mock-model")
			return { text: "Fixture title", usage: { input_tokens: 100, output_tokens: 10 } };
		if (issued || !JSON.stringify(body).includes("READ-IMAGE")) return null;
		issued = true;
		return {
			openaiOutput: [
				{
					type: "function_call",
					id: "fc_read_image",
					call_id: CALL_ID,
					name: "read",
					arguments: JSON.stringify({ path: png }),
				},
			],
			usage: { input_tokens: 100, output_tokens: 10 },
		};
	});
	mock.setDefault({ text: "ok", usage: { input_tokens: 100, output_tokens: 20 } });
	/** Run one user turn; returns the session model's requests that carry its text. */
	const turn = async (text: string): Promise<Body[]> => {
		const before = mock.requests().length;
		await client.session.prompt({ sessionID: session.id, text });
		await client.session.wait({ sessionID: session.id }, { signal: AbortSignal.timeout(60_000) });
		const listed = (await client.message.list({ sessionID: session.id })) as { data: Row[] };
		expect({ text, outcome: listed.data.find((row) => row.type === "idle")?.outcome }).toEqual({
			text,
			outcome: "succeeded",
		});
		const bodies = mock
			.requests()
			.slice(before)
			.map((request) => request.body as Body)
			.filter((body) => body.model === "mock-model" && JSON.stringify(body).includes(text));
		expect(bodies.length).toBeGreaterThan(0);
		return bodies;
	};
	const restart = async () => {
		await host.stopHost();
		host = await spawnOpencode2({
			visionModel: true,
			magicContextConfig: baseConfig,
			...options,
			existingIsolation: { root: host.root, env: host.env, cwd: host.cwd },
			existingMock: { mock, baseURL: host.mockBaseURL },
		});
		client = connect();
		await waitForPluginActive(client, host.cwd);
	};
	return { host: () => host, mock, session, turn, restart, readIssued: () => issued };
}

/** The host's own rendering of the read result, with no plugin loaded. */
async function hostOwnReadResult() {
	const run = await readImageSession({ includeMagicContext: false });
	try {
		const bodies = await run.turn("READ-IMAGE please look at pixel.png");
		const result = bodies.map(readResult).find(Boolean);
		expect(result).toBeDefined();
		return result!;
	} finally {
		await run.host().stop();
	}
}

test("a tool-result image reaches the provider as the host's own image block, and a priced pass's prefix survives the defer after it", async () => {
	const hostResult = await hostOwnReadResult();
	// Precondition: without Magic Context the host sends the read as text plus an image block.
	expect(Array.isArray(hostResult.output)).toBe(true);
	const hostImage = (hostResult.output as Array<{ type?: string }>).find(
		(entry) => entry.type === "input_image",
	);
	expect(JSON.stringify(hostImage)).toContain(PNG_BASE64);

	const fixture = isolation();
	const logPath = join(fixture.root, "magic-context.log");
	fixture.env.MAGIC_CONTEXT_LOG_PATH = logPath;
	const log = () => (existsSync(logPath) ? readFileSync(logPath, "utf8") : "");
	const run = await readImageSession({ existingIsolation: fixture });
	try {
		const readBodies = await run.turn("READ-IMAGE please look at pixel.png");
		expect(run.readIssued()).toBe(true);
		const mc = new Database(join(fixture.env.MAGIC_CONTEXT_STORAGE_DIR!, "context.db"));
		mc.exec("PRAGMA busy_timeout = 5000");
		const logStart = log().length;
		// A stale m[0] system hash makes the next pass priced: it rebuilds the cached prefix.
		mc.prepare("UPDATE session_meta SET cached_m0_system_hash = 'stale' WHERE session_id = ?").run(
			run.session.id,
		);
		mc.close();
		const priced = (await run.turn("PASS-A-PRICED")).at(-1)!;
		const deferred = (await run.turn("PASS-B-DEFER")).at(-1)!;
		const passLog = log().slice(logStart);
		expect(passLog).toContain("HARD fold decision: reason=system_hash executed=true");
		expect(passLog.match(/HARD fold decision/g)).toHaveLength(1);

		const withResult = [...readBodies, priced, deferred].filter((body) => readResult(body));
		expect(withResult.length).toBeGreaterThanOrEqual(3);
		for (const body of withResult) {
			const output = readResult(body)!.output;
			// Never the result serialized into a string: that is base64 as model-visible text.
			expect(typeof output).not.toBe("string");
			const entries = output as Array<{ type?: string; text?: string }>;
			// The host's own image block, byte for byte, and its text with only the tag added.
			expect(imageBlock(body)).toBe(JSON.stringify(hostImage));
			expect(entries.map((entry) => entry.type)).toEqual(
				(hostResult.output as Array<{ type?: string }>).map((entry) => entry.type),
			);
			const hostText = (hostResult.output as Array<{ type?: string; text?: string }>).find(
				(entry) => entry.type === "input_text",
			)!.text!;
			expect(entries.find((entry) => entry.type === "input_text")?.text).toMatch(
				new RegExp(`^§\\d+§ ${hostText}$`),
			);
		}
		// The defer appends to the priced pass: the priced pass's bytes are an exact prefix.
		expect(sha(deferred.input!.slice(0, priced.input!.length))).toBe(sha(priced.input));

		// Every database the host process group holds open lives under the throwaway root.
		const host = run.host();
		const openDatabases = inspectOpenFiles(host.pid!, host.root, host.env).filter((path) =>
			/\.db(-wal|-shm)?$/.test(path),
		);
		expect(openDatabases.length).toBeGreaterThan(0);
		for (const path of openDatabases) expect(path.startsWith(host.root)).toBe(true);
		console.log(`host open databases: ${JSON.stringify(openDatabases)}`);
	} catch (error) {
		console.error(run.host().stderr().slice(-3000), log().slice(-6000));
		throw error;
	} finally {
		await run.host().stop();
	}
}, 240_000);

// After the host folds the session into a compaction checkpoint it stops serving the rows
// before it, and Magic Context restores them from the host's store. A restored image result
// must reach the provider exactly as it did before the fold, in the same process and after a
// host restart.
for (const arm of ["same-process", "after-restart"] as const) {
	test(`a tool-result image restored from before a host compaction checkpoint reaches the provider byte-identical (${arm})`, async () => {
		const fixture = isolation();
		const logPath = join(fixture.root, "magic-context.log");
		fixture.env.MAGIC_CONTEXT_LOG_PATH = logPath;
		const log = () => (existsSync(logPath) ? readFileSync(logPath, "utf8") : "");
		const run = await readImageSession({
			existingIsolation: fixture,
			// A small window lets one reported high-usage turn make the host compact.
			modelContextLimit: 16_000,
			modelOutputLimit: 1024,
		});
		try {
			await run.turn("READ-IMAGE please look at pixel.png");
			run.mock.setDefault({ text: "pressure answer", usage: { input_tokens: 15_000, output_tokens: 10 } });
			const beforeFold = readResult((await run.turn("PRESSURE-TURN")).at(-1)!);
			expect(beforeFold).toBeDefined();
			expect(imageBlock({ input: [beforeFold!] })).toContain(PNG_BASE64);
			run.mock.setDefault({ text: "ok", usage: { input_tokens: 100, output_tokens: 20 } });
			const after = [await run.turn("AFTER-FOLD-1")];
			if (arm === "after-restart") await run.restart();
			after.push(await run.turn("AFTER-FOLD-2"));

			// Precondition: the host checkpointed after the read, so the read result reaches
			// the request only through Magic Context's restore.
			const host = run.host();
			const reader = new V2StoreReader(gaDatabasePath(host.env.XDG_DATA_HOME!, "latest", host.env));
			try {
				const cut = reader.latestCompaction(run.session.id);
				expect(cut?.data.status).toBe("completed");
				const readRow = reader
					.history(run.session.id)
					.find((row) => row.type === "assistant" && JSON.stringify(row.data).includes(CALL_ID));
				expect(reader.sequenceForId(run.session.id, readRow!.id)!).toBeLessThan(cut!.seq);
			} finally {
				reader.close();
			}
			for (const bodies of after)
				for (const body of bodies) expect(readResult(body)).toEqual(beforeFold);
		} catch (error) {
			console.error(run.host().stderr().slice(-3000), log().slice(-6000));
			throw error;
		} finally {
			await run.host().stop();
		}
	}, 240_000);
}
