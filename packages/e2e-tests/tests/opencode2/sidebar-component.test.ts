import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { OpenCode } from "@opencode/client";
import {
	PLUGIN,
	spawnOpencode2,
	waitForPluginActive,
} from "../../src/opencode2-runner/spawn";
import {
	captureTui,
	ptyCaptureAvailable,
} from "../../src/opencode2-runner/tui-capture";

const pluginVersion = (
	JSON.parse(readFileSync(join(PLUGIN, "package.json"), "utf8")) as {
		version: string;
	}
).version;

/**
 * Rows only the real sidebar component draws. The plain-text projection the v2
 * TUI falls back to writes a four-line block ("Magic Context", "Context …",
 * "Historian idle · C:n", "Memories n/n · Q:n") and none of these:
 *   - the collapse triangle and version in the header badge,
 *   - a "Compartments" row (the text projection folds that count into "C:n"),
 *   - the token-breakdown legend, whose "Conversation" row is drawn only from a
 *     snapshot with a non-zero input-token count, so it is also the proof that
 *     live RPC data reached the component rather than a placeholder.
 */
const COMPONENT_MARKERS = [
	"▼ Magic Context",
	`v${pluginVersion}`,
	"Compartments",
	"Conversation",
	"Historian",
	"Memories",
];

/** Substrings only the text projection produces. */
const TEXT_PROJECTION_MARKERS = ["· C:", "Magic Context · loading…"];

test("the OpenCode 1 sidebar component paints on the real 2.0.5 sidebar.content slot", async () => {
	// A missing PTY allocator means the claim cannot be checked at all, so say
	// that rather than passing on an unrun assertion.
	expect(ptyCaptureAvailable()).toBe(true);

	const host = await spawnOpencode2();
	try {
		const client = OpenCode.make({
			baseUrl: host.url,
			headers: { authorization: `Basic ${btoa(`opencode:${host.password}`)}` },
		});
		const session = await client.session.create({
			title: "sidebar component render",
			location: { directory: host.cwd },
			model: { providerID: "openai", id: "mock-model" },
		});
		await waitForPluginActive(client, host.cwd);
		host.mock.setDefault({
			text: "fixture reply",
			usage: { input_tokens: 4200, output_tokens: 10 },
		});
		await client.session.prompt({
			sessionID: session.id,
			text: "sidebar fixture prompt",
		});
		await client.session.wait(
			{ sessionID: session.id },
			{ signal: AbortSignal.timeout(30_000) },
		);

		// The TUI boots its own server against the same throwaway roots, so the
		// serve host has to let go of the store first.
		await host.stopHost();

		const capture = await captureTui({
			env: host.env,
			root: host.root,
			cwd: host.cwd,
			sessionID: session.id,
			markers: COMPONENT_MARKERS,
			timeoutMs: 120_000,
		});
		expect({ missing: capture.missing }).toEqual({ missing: [] });
		for (const marker of TEXT_PROJECTION_MARKERS)
			expect(capture.text).not.toContain(marker);

		// Live-store rule: the fd table must have been sampled while the host held
		// databases open, and every one of them inside the throwaway root
		// (captureTui throws on any database outside it).
		expect(capture.sampled).toBe(true);
		expect(capture.openDatabases.length).toBeGreaterThan(0);
		expect(
			capture.openDatabases.filter((path) => !path.startsWith(`${host.root}/`)),
		).toEqual([]);
		expect(
			capture.openDatabases.some((path) =>
				path.endsWith("cortexkit/magic-context/context.db"),
			),
		).toBe(true);
	} finally {
		await host.stop();
	}
}, 240_000);
