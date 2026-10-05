import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { OpenCode } from "@opencode/client";
import {
	isolation,
	spawnOpencode2,
	waitForPluginActive,
} from "../../src/opencode2-runner/spawn";
import {
	captureTui,
	ptyCaptureAvailable,
} from "../../src/opencode2-runner/tui-capture";

/**
 * OpenCode 2 has no `command.execute.before` hook, so the TUI keymap layer is
 * the only place a `/ctx-*` command can come from on this host. The plugin
 * reports the accepted layer's slash names once registration succeeds, so what
 * this asserts is the real TUI's own record of what the host received — a name
 * missing here is missing from the host's command palette.
 *
 * The report is read from the plugin's diagnostic log rather than the screen
 * because the host owns the terminal and drops plugin console output.
 */
const EXPECTED_COMMANDS = [
	"ctx-status",
	"ctx-recomp",
	"ctx-dream",
	"ctx-flush",
	"ctx-embed",
	"ctx-wrapup",
];
const REGISTRATION_PREFIX = "registered slash commands:";

test("the OpenCode 2 TUI registers every /ctx-* command through the keymap layer", async () => {
	// Without a PTY allocator the TUI never boots, so the claim cannot be
	// checked at all; say that rather than passing on an unrun assertion.
	expect(ptyCaptureAvailable()).toBe(true);

	const fixture = isolation();
	const logPath = join(fixture.root, "magic-context-tui.log");
	fixture.env.MAGIC_CONTEXT_LOG_PATH = logPath;
	const host = await spawnOpencode2({ existingIsolation: fixture });
	try {
		const client = OpenCode.make({
			baseUrl: host.url,
			headers: { authorization: `Basic ${btoa(`opencode:${host.password}`)}` },
		});
		const session = await client.session.create({
			title: "keymap command registration",
			location: { directory: host.cwd },
			model: { providerID: "openai", id: "mock-model" },
		});
		await waitForPluginActive(client, host.cwd);

		// The TUI boots its own server against the same throwaway roots, so the
		// serve host has to let go of the store first.
		await host.stopHost();

		// "Magic Context" is the sidebar the same setup() call mounts, so its
		// paint is the signal that the TUI plugin ran to completion.
		const capture = await captureTui({
			env: host.env,
			root: host.root,
			cwd: host.cwd,
			sessionID: session.id,
			markers: ["Magic Context"],
			timeoutMs: 120_000,
		});
		expect({ missing: capture.missing }).toEqual({ missing: [] });

		if (!existsSync(logPath)) throw new Error("the TUI wrote no plugin log");
		const line = readFileSync(logPath, "utf8")
			.split("\n")
			.find((row) => row.includes(REGISTRATION_PREFIX));
		if (!line) throw new Error("the TUI logged no command registration line");
		const registered = line
			.slice(line.indexOf(REGISTRATION_PREFIX) + REGISTRATION_PREFIX.length)
			.trim()
			.split(/\s+/)
			.filter((name) => name.startsWith("ctx-"));
		expect(registered).toEqual(EXPECTED_COMMANDS);

		// Live-store rule: every database the TUI process group held open was
		// inside the throwaway root (captureTui throws on any database outside it).
		expect(capture.sampled).toBe(true);
		expect(
			capture.openDatabases.filter((path) => !path.startsWith(`${host.root}/`)),
		).toEqual([]);
	} finally {
		await host.stop();
	}
}, 240_000);
