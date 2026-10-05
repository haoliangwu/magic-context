import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { OpenCode } from "@opencode/client";
import { Database } from "../../../plugin/src/shared/sqlite";
import {
	isolation,
	spawnOpencode2,
	waitForPluginActive,
} from "../../src/opencode2-runner/spawn";

// A command response alone cannot prove the hidden historian published anything.
// Read only the throwaway context store owned by this host after the command returns.
test("OpenCode 2 /ctx-wrapup publishes compartments through the hidden executor", async () => {
	const fixture = isolation();
	const logPath = join(fixture.root, "wrapup.log");
	fixture.env.MAGIC_CONTEXT_LOG_PATH = logPath;
	const host = await spawnOpencode2({
		existingIsolation: fixture,
		modelContextLimit: 16_000,
		modelOutputLimit: 1_024,
		magicContextConfig: {
			memory: { enabled: false },
			dreamer: { disable: true },
			historian: { two_pass: false },
		},
	});
	try {
		const client = OpenCode.make({
			baseUrl: host.url,
			headers: { authorization: `Basic ${btoa(`opencode:${host.password}`)}` },
		});
		const session = await client.session.create({
			title: "wrapup hidden completion",
			location: { directory: host.cwd },
			model: { providerID: "openai", id: "mock-model" },
		});
		await waitForPluginActive(client, host.cwd);
		host.mock.setDefault({
			text: "ordinary turn",
			usage: { input_tokens: 100, output_tokens: 10 },
		});
		for (let index = 0; index < 6; index++) {
			await client.session.prompt({
				sessionID: session.id,
				text: `Source turn ${index}: ${"durable history ".repeat(80)}`,
			});
			await client.session.wait(
				{ sessionID: session.id },
				{ signal: AbortSignal.timeout(30_000) },
			);
		}
		let historianCalls = 0;
		host.mock.addMatcher((body) => {
			const range = JSON.stringify(body).match(/Messages (\d+)-(\d+):/);
			if (!range) return null;
			historianCalls++;
			return {
				text: `<compartment start="${range[1]}" end="${range[2]}" title="Source history"><p1>The source turns record durable history.</p1></compartment>`,
				usage: { input_tokens: 100, output_tokens: 40 },
			};
		});
		if (!host.env.XDG_DATA_HOME)
			throw new Error("isolated data root is missing");
		const db = new Database(
			join(host.env.XDG_DATA_HOME, "cortexkit", "magic-context", "context.db"),
			{
				readonly: true,
				fileMustExist: true,
			},
		);
		try {
			const row = db
				.prepare(
					"SELECT COUNT(*) AS count FROM compartments WHERE session_id = ?",
				)
				.get(session.id) as { count: number };
			expect(row.count).toBe(0);
			await client.session.command({
				sessionID: session.id,
				name: "ctx-wrapup",
				text: "2",
			});
			const deadline = Date.now() + 30_000;
			let count = row.count;
			while (count === row.count && Date.now() < deadline) {
				await Bun.sleep(100);
				count = (
					db
						.prepare(
							"SELECT COUNT(*) AS count FROM compartments WHERE session_id = ?",
						)
						.get(session.id) as { count: number }
				).count;
			}
			expect(historianCalls).toBeGreaterThan(0);
			expect(count).toBeGreaterThan(row.count);
		} finally {
			db.close();
		}
	} catch (error) {
		console.error(
			host.stderr(),
			existsSync(logPath) ? readFileSync(logPath, "utf8") : "(no plugin log)",
		);
		throw error;
	} finally {
		await host.stop();
	}
}, 180_000);
