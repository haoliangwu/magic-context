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
	ptyInputAvailable,
} from "../../src/opencode2-runner/tui-capture";

const pluginVersion = (
	JSON.parse(readFileSync(join(PLUGIN, "package.json"), "utf8")) as {
		version: string;
	}
).version;

/**
 * Rows only the real dialog component draws. The plain-text projection the v2
 * TUI falls back to writes six "Label: value" lines ("Context:", "Historian:",
 * "Compartments:", …) and none of these: the title badge with the plugin
 * version, the two-column section titles, the token-breakdown legend, or the
 * dialog footer.
 */
const COMPONENT_MARKERS = [
	"⚡ Magic Context Status",
	`v${pluginVersion}`,
	"Reductions",
	"Pending Queue",
	"Context Details",
	"Cache TTL",
	"History Compression",
	"Conversation",
	"Esc to close",
];

/** Substrings only the text projection produces. */
const TEXT_PROJECTION_MARKERS = ["Pending reductions:", "Harness: opencode2"];

/** Rows the one status view no longer carries; none of them may come back. */
const DELETED_MARKERS = ["Diagnostics", "Logger", "Importance", "Swallowed"];

async function captureStatusDialog(themeMode: "dark" | "light") {
	// The host resolves one theme per boot from config; `theme.mode` is what
	// selects between the dark and light variants without a keystroke.
	const host = await spawnOpencode2({
		extraConfig: { theme: { mode: themeMode } },
	});
	try {
		const client = OpenCode.make({
			baseUrl: host.url,
			headers: { authorization: `Basic ${btoa(`opencode:${host.password}`)}` },
		});
		const session = await client.session.create({
			title: `status dialog ${themeMode}`,
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
			text: "status fixture prompt",
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
			// Typed the way a user reaches it: the slash command, then Enter to
			// accept the completion the host offers and Enter again to run it.
			keys: ["/ctx-status", "\r", "\r"],
			markers: COMPONENT_MARKERS,
			timeoutMs: 120_000,
		});
		return { capture, root: host.root };
	} finally {
		await host.stop();
	}
}

for (const themeMode of ["dark", "light"] as const) {
	test(`the /ctx-status dialog component paints on the real 2.0.15 dialog surface (${themeMode} theme)`, async () => {
		// A missing PTY allocator or keyboard means the claim cannot be checked at
		// all, so say that rather than passing on an unrun assertion.
		expect({ pty: ptyCaptureAvailable(), keyboard: ptyInputAvailable() }).toEqual({
			pty: true,
			keyboard: true,
		});

		const { capture, root } = await captureStatusDialog(themeMode);
		expect({ missing: capture.missing }).toEqual({ missing: [] });
		for (const marker of TEXT_PROJECTION_MARKERS)
			expect(capture.text).not.toContain(marker);
		for (const marker of DELETED_MARKERS)
			expect(capture.text).not.toContain(marker);

		// Live-store rule: the fd table must have been sampled while the host held
		// databases open, and every one of them inside the throwaway root
		// (captureTui throws on any database outside it).
		expect(capture.sampled).toBe(true);
		expect(capture.openDatabases.length).toBeGreaterThan(0);
		expect(
			capture.openDatabases.filter((path) => !path.startsWith(`${root}/`)),
		).toEqual([]);
	}, 240_000);
}
