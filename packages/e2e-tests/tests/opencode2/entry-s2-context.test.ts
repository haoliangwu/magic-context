import { expect, test } from "bun:test";
import { OpenCode } from "@opencode/client";
import { spawnOpencode2, waitForPluginActive } from "../../src/opencode2-runner/spawn";

test("I1 s2 dual-loader directory entry activates on the real GA host", async () => {
	const host = await spawnOpencode2();
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
		host.mock.setDefault({
			text: "s2 reply",
			usage: { input_tokens: 100, output_tokens: 10 },
		});
		await client.session.prompt({ sessionID: session.id, text: "s2 prompt" });
		await client.session.wait(
			{ sessionID: session.id },
			{ signal: AbortSignal.timeout(20_000) },
		);
		expect(
			host.mock
				.requests()
				.filter((request) => request.body.model === "mock-model"),
		).toHaveLength(1);
		expect(host.stdout() + host.stderr()).toContain(
			"@cortexkit/opencode-magic-context v2 setup",
		);
	} catch (error) {
		console.error(host.stdout(), host.stderr());
		throw error;
	} finally {
		await host.stop();
	}
}, 60000);
