import { describe, expect, it, mock } from "bun:test";
import type { SubagentRunner } from "@magic-context/core/shared/subagent-runner";
import { createPiHistorianClient } from "./pi-recomp-client-shared";

function makeClient(maxOutputTokens?: number) {
	const run = mock(async (_options: Record<string, unknown>) => ({
		ok: true as const,
		assistantText: "historian output",
	}));
	const client = createPiHistorianClient({
		runner: { run } as unknown as SubagentRunner,
		model: "provider/model",
		systemPrompt: "system",
		maxOutputTokens,
		directory: "/tmp/project",
		accountingSessionId: "session-1",
		notify: () => {},
	});
	return { client, run };
}

async function prompt(client: ReturnType<typeof createPiHistorianClient>) {
	const session = await client.session.create();
	await client.session.prompt({
		path: { id: session.id },
		body: { parts: [{ type: "text", text: "summarize this history" }] },
	});
}

describe("Pi recomp historian output cap", () => {
	it("passes the configured cap to the subagent runner", async () => {
		const { client, run } = makeClient(65_536);

		await prompt(client);

		expect(run).toHaveBeenCalledTimes(1);
		expect(run.mock.calls[0]?.[0].maxOutputTokens).toBe(65_536);
	});

	it("leaves the cap unset when historian.maxTokens is unset", async () => {
		const { client, run } = makeClient();

		await prompt(client);

		expect(run).toHaveBeenCalledTimes(1);
		expect(run.mock.calls[0]?.[0].maxOutputTokens).toBeUndefined();
	});
});

it("forwards per-call tail admission through Pi recomp without changing prompt bytes", async () => {
	const { client, run } = makeClient();
	const session = await client.session.create();
	for (const cacheTail of ["skip", "write"] as const) {
		await client.session.prompt({
			path: { id: session.id },
			cacheTail,
			body: { parts: [{ type: "text", text: "same prompt" }] },
		});
	}
	expect(run.mock.calls.map(([options]) => options.cacheTail)).toEqual([
		"skip",
		"write",
	]);
	expect(run.mock.calls.map(([options]) => options.userMessage)).toEqual([
		"same prompt",
		"same prompt",
	]);
});
