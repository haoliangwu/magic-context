import { expect, test } from "bun:test";
import { awaitPluginActivation, type PluginActivationClient } from "./plugin-activation";

function clientWith(
	plugins: Array<{
		id: string;
		state:
			| { status: "active" }
			| { status: "failed"; error: string; ref?: string };
	}>,
	events: AsyncIterable<unknown> = (async function* () {})(),
): PluginActivationClient {
	return {
		event: {
			subscribe() {
				return events;
			},
		},
		plugin: {
			async list() {
				return { data: plugins };
			},
		},
	};
}

test("failed plugin inventory must not open an event subscription", async () => {
	const client: PluginActivationClient = {
		event: {
			subscribe() {
				throw new Error("must not subscribe when inventory is already failed");
			},
		},
		plugin: {
			async list() {
				return {
					data: [
						{
							id: "broken-activation",
							state: {
								status: "failed",
								error: "deliberate broken plugin fixture",
							},
						},
					],
				};
			},
		},
	};
	await expect(
		awaitPluginActivation(client, "/tmp", "broken-activation", 30_000),
	).rejects.toThrow("Plugin broken-activation failed: deliberate broken plugin fixture");
});

test("failed plugin inventory fails fast with the host error and ref", async () => {
	const started = Date.now();
	await expect(
		awaitPluginActivation(
			clientWith([
				{
					id: "broken-activation",
					state: {
						status: "failed",
						error: "deliberate broken plugin fixture",
						ref: "ref-1",
					},
				},
			]),
			"/tmp",
			"broken-activation",
			30_000,
		),
	).rejects.toThrow("Plugin broken-activation failed: deliberate broken plugin fixture (ref: ref-1)");
	expect(Date.now() - started).toBeLessThan(1_000);
});

test("active plugin inventory returns without waiting for events", async () => {
	const plugin = await awaitPluginActivation(
		clientWith([
			{ id: "opencode-magic-context", state: { status: "active" } },
		]),
		"/tmp",
	);
	expect(plugin.state.status).toBe("active");
});

test("already-active inventory must not open an event subscription", async () => {
	const client: PluginActivationClient = {
		event: {
			subscribe() {
				throw new Error("must not subscribe when inventory is already active");
			},
		},
		plugin: {
			async list() {
				return {
					data: [
						{
							id: "opencode-magic-context",
							state: { status: "active" },
						},
					],
				};
			},
		},
	};
	const plugin = await awaitPluginActivation(client, "/tmp");
	expect(plugin.state.status).toBe("active");
});

test("deadline is only a backstop when inventory never becomes terminal", async () => {
	const client: PluginActivationClient = {
		event: {
			subscribe() {
				return {
					[Symbol.asyncIterator]: () => ({
						next: () => new Promise<IteratorResult<unknown>>(() => undefined),
						return: async () => ({ done: true, value: undefined }),
					}),
				};
			},
		},
		plugin: {
			async list() {
				return { data: [] };
			},
		},
	};
	await expect(
		awaitPluginActivation(client, "/tmp", "opencode-magic-context", 50),
	).rejects.toThrow("Timed out waiting for plugin opencode-magic-context activation");
});
