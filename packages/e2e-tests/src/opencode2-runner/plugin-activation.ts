type PluginState =
	| { status: "active" }
	| { status: "failed"; error: string; ref?: string };

export type PluginEntry = {
	id?: string;
	state: PluginState;
};

export type PluginActivationClient = {
	event: {
		subscribe(options?: { signal?: AbortSignal }): AsyncIterable<unknown>;
	};
	plugin: {
		list(input: {
			location: { directory: string };
		}): Promise<{ data: PluginEntry[] }>;
	};
};

function eventType(event: unknown): string | undefined {
	if (!event || typeof event !== "object") return undefined;
	const record = event as { type?: unknown; payload?: { type?: unknown } };
	if (typeof record.type === "string") return record.type;
	if (typeof record.payload?.type === "string") return record.payload.type;
	return undefined;
}

/**
 * OpenCode 2.0.5 removed plugin.awaitActivation. Inventory is authoritative:
 * subscribe to plugin.updated, re-read plugin.list, accept status "active",
 * fail fast on "failed" with the host error/ref, and use the deadline only as
 * a backstop. The first context hook firing is not a readiness signal.
 */
export async function awaitPluginActivation(
	client: PluginActivationClient,
	directory: string,
	pluginID = "opencode-magic-context",
	timeoutMs = 20_000,
): Promise<PluginEntry> {
	const readTerminalState = async (): Promise<PluginEntry | undefined> => {
		const plugins = await client.plugin.list({ location: { directory } });
		const plugin = plugins.data.find((entry) => entry.id === pluginID);
		if (plugin?.state.status === "failed") {
			const ref = plugin.state.ref ? ` (ref: ${plugin.state.ref})` : "";
			throw new Error(
				`Plugin ${pluginID} failed: ${plugin.state.error}${ref}`,
			);
		}
		return plugin?.state.status === "active" ? plugin : undefined;
	};

	// 2.0.5 does not drain a session inbox while a client holds /api/event.
	// Read inventory first and skip subscribe when the plugin is already terminal.
	const ready = await readTerminalState();
	if (ready) return ready;

	const events = client.event.subscribe()[Symbol.asyncIterator]();
	let deadline: ReturnType<typeof setTimeout> | undefined;
	const timedOut = new Promise<never>((_, reject) => {
		deadline = setTimeout(() => {
			reject(
				new Error(`Timed out waiting for plugin ${pluginID} activation`),
			);
		}, timeoutMs);
	});
	let nextEvent = events.next();

	try {
		for (;;) {
			const plugin = await Promise.race([readTerminalState(), timedOut]);
			if (plugin) return plugin;

			const event = await Promise.race([nextEvent, timedOut]);
			if (event.done) {
				const finalPlugin = await readTerminalState();
				if (finalPlugin) return finalPlugin;
				throw new Error("Plugin event stream ended before activation");
			}
			nextEvent = events.next();
			const type = eventType(event.value);
			if (type !== undefined && type !== "plugin.updated") continue;
		}
	} finally {
		if (deadline) clearTimeout(deadline);
	}
}
