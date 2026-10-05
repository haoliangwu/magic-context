import { expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { OpenCode } from "@opencode/client";
import { gaDatabasePath, V2StoreReader } from "../../../plugin/src/v2/store-reader";
import {
	isolation,
	spawnOpencode2,
	waitForPluginActive,
} from "../../src/opencode2-runner/spawn";

// A 1x1 PNG. Attached the way the TUI and the HTTP API attach images: as a
// `files` entry on the prompt, once inline (a pasted image) and once by file URI.
const PNG_BASE64 =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

type Row = { type?: string; outcome?: string };

for (const attach of ["inline", "file-uri"] as const) {
	test(`image attachment (${attach}) and the turns after it reach the provider with Magic Context loaded`, async () => {
		const host = await spawnOpencode2({
			magicContextConfig: {
				historian: { disable: true },
				dreamer: { disable: true },
				memory: { enabled: false },
			},
			mockResponse: { text: "ok", usage: { input_tokens: 100, output_tokens: 20 } },
		});
		try {
			const client = OpenCode.make({
				baseUrl: host.url,
				headers: { authorization: `Basic ${btoa(`opencode:${host.password}`)}` },
			});
			const session = await client.session.create({
				location: { directory: host.cwd },
				model: { providerID: "openai", id: "mock-model" },
			});
			await waitForPluginActive(client, host.cwd);
			const png = join(host.cwd, "pixel.png");
			writeFileSync(png, Buffer.from(PNG_BASE64, "base64"));
			const uri =
				attach === "inline" ? `data:image/png;base64,${PNG_BASE64}` : `file://${png}`;

			const prompts = ["what is in this image?", "and now?", "one more turn"];
			for (const [turn, text] of prompts.entries()) {
				const before = host.mock.requests().length;
				await client.session.prompt({
					sessionID: session.id,
					text,
					...(turn === 0 ? { files: [{ uri, name: "pixel.png" }] } : {}),
				});
				await client.session.wait(
					{ sessionID: session.id },
					{ signal: AbortSignal.timeout(60_000) },
				);
				// session.wait resolves on idle whether the turn succeeded or not, so read
				// the idle row the host wrote for this turn. On OpenCode 2.0.15 a malformed
				// attachment fails inside the host's own request preparation with "Schema
				// validation failed", before any provider request is made.
				const listed = (await client.message.list({ sessionID: session.id })) as {
					data: Row[];
				};
				const idle = listed.data.find((row) => row.type === "idle");
				const failure = host
					.stderr()
					.split("\n")
					.find((line) => line.includes("Schema validation failed"))
					?.slice(0, 300);
				expect({ turn, outcome: idle?.outcome, failure }).toEqual({
					turn,
					outcome: "succeeded",
					failure: undefined,
				});
				const turnRequests = host.mock
					.requests()
					.slice(before)
					.map((request) => JSON.stringify(request.body));
				// The host's title generation also sends the first prompt, through its own
				// title model; only the session model's requests carry the conversation.
				const primary = turnRequests.filter(
					(body) => body.includes('"model":"mock-model"') && body.includes(text),
				);
				expect(primary.length).toBeGreaterThan(0);
				// The image stays in the conversation the provider sees on every turn.
				expect(primary.every((body) => body.includes(PNG_BASE64))).toBe(true);
			}
		} finally {
			await host.stop();
		}
	}, 180_000);
}

// After the host folds the session into a compaction checkpoint, it no longer serves the
// rows before the checkpoint; Magic Context restores them from the host's store itself.
// A restored image must reach the host in the host's own Media.Asset shape, or the host
// rejects every turn after the fold.
//
// same-process: the host already put a Media.Asset in an earlier draft, so the restore
//   reuses that class.
// after-restart: a fresh host process whose drafts never held an attachment, so the
//   restore has to decode through the host's own message schema.
//
// In both arms the restored image must reach the provider byte-identical to the host's
// own rendering of the same row before the fold, and must never fall back to the text
// note that replaces an attachment the restore cannot rebuild.
type Body = { input?: unknown[] };
const imageElements = (body: Body) => {
	const item = (body.input ?? []).find((entry) => JSON.stringify(entry).includes("IMAGE-TURN")) as
		| { content?: unknown[] }
		| undefined;
	return JSON.stringify(
		(item?.content ?? []).filter((part) => JSON.stringify(part).includes(PNG_BASE64)),
	);
};

for (const arm of ["same-process", "after-restart"] as const) {
	test(`an image restored from before a host compaction checkpoint reaches the provider byte-identical (${arm})`, async () => {
		const fixture = isolation();
		const logPath = join(fixture.root, "magic-context.log");
		fixture.env.MAGIC_CONTEXT_LOG_PATH = logPath;
		const options = {
			// A small window lets one reported high-usage turn make the host compact.
			modelContextLimit: 16_000,
			modelOutputLimit: 1024,
			magicContextConfig: {
				historian: { disable: true },
				dreamer: { disable: true },
				memory: { enabled: false },
			},
			mockResponse: { text: "ok", usage: { input_tokens: 100, output_tokens: 20 } },
		};
		let host = await spawnOpencode2({ ...options, existingIsolation: fixture });
		const mock = host.mock;
		const log = () => (existsSync(logPath) ? readFileSync(logPath, "utf8") : "");
		const connect = () =>
			OpenCode.make({
				baseUrl: host.url,
				headers: { authorization: `Basic ${btoa(`opencode:${host.password}`)}` },
			});
		try {
			let client = connect();
			const session = await client.session.create({
				location: { directory: host.cwd },
				model: { providerID: "openai", id: "mock-model" },
			});
			await waitForPluginActive(client, host.cwd);
			const turn = async (text: string, files?: Array<{ uri: string; name: string }>) => {
				const before = mock.requests().length;
				await client.session.prompt({ sessionID: session.id, text, ...(files ? { files } : {}) });
				await client.session.wait({ sessionID: session.id }, { signal: AbortSignal.timeout(60_000) });
				const listed = (await client.message.list({ sessionID: session.id })) as { data: Row[] };
				const failure = host
					.stderr()
					.split("\n")
					.find((line) => line.includes("Failed to drain Session"))
					?.slice(0, 300);
				expect({
					text,
					outcome: listed.data.find((row) => row.type === "idle")?.outcome,
					failure,
				}).toEqual({ text, outcome: "succeeded", failure: undefined });
				const bodies = mock
					.requests()
					.slice(before)
					.map((request) => request.body as Body)
					.filter((body) => {
						const json = JSON.stringify(body);
						return json.includes('"model":"mock-model"') && json.includes(text);
					});
				expect(bodies.length).toBeGreaterThan(0);
				return bodies;
			};

			await turn("IMAGE-TURN what is in this image?", [
				{ uri: `data:image/png;base64,${PNG_BASE64}`, name: "pixel.png" },
			]);
			mock.setDefault({ text: "pressure answer", usage: { input_tokens: 15_000, output_tokens: 10 } });
			// The host's own rendering of the image row, before any checkpoint exists.
			const hostRendered = imageElements((await turn("PRESSURE-TURN")).at(-1)!);
			expect(hostRendered).toContain(PNG_BASE64);
			mock.setDefault({ text: "ok", usage: { input_tokens: 100, output_tokens: 20 } });
			const after = [await turn("AFTER-FOLD-1")];
			if (arm === "after-restart") {
				await host.stopHost();
				host = await spawnOpencode2({
					...options,
					existingIsolation: { root: host.root, env: host.env, cwd: host.cwd },
					existingMock: { mock, baseURL: host.mockBaseURL },
				});
				client = connect();
				await waitForPluginActive(client, host.cwd);
			}
			after.push(await turn("AFTER-FOLD-2"));

			// Precondition: the host really checkpointed after the image row, so the image
			// row reaches the request only through Magic Context's restore.
			const reader = new V2StoreReader(gaDatabasePath(host.env.XDG_DATA_HOME!, "latest", host.env));
			try {
				const cut = reader.latestCompaction(session.id);
				expect(cut?.data.status).toBe("completed");
				const imageRow = reader
					.history(session.id)
					.find((row) => row.type === "user" && JSON.stringify(row.data).includes("IMAGE-TURN"));
				expect(reader.sequenceForId(session.id, imageRow!.id)!).toBeLessThan(cut!.seq);
			} finally {
				reader.close();
			}
			for (const bodies of after)
				for (const body of bodies) expect(imageElements(body)).toBe(hostRendered);
			expect(log()).not.toContain("attachment replaced by a note");
		} catch (error) {
			console.error(host.stderr().slice(-3000), log().slice(-6000));
			throw error;
		} finally {
			await host.stop();
		}
	}, 180_000);
}
