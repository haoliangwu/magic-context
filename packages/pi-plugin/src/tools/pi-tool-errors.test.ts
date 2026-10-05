import { describe, expect, it } from "bun:test";
import { insertTag } from "@magic-context/core/features/magic-context/storage-tags";
import { closeQuietly } from "@magic-context/core/shared/sqlite-helpers";
import { runAgentLoop } from "pi-agent-core-087";
import { createTestDb } from "../test-utils.test";
import { registerMagicContextTools } from "./index";

// Exercise Pi's actual tool-execution path: calling an extension's execute directly
// cannot establish the error flag that Pi records on the toolResult message.
async function runReduce(drop: string) {
	const db = createTestDb();
	try {
		const sessionId = "ses-pi-tool-errors";
		insertTag(db, sessionId, "m1", "text", 100, 1);
		const tools: unknown[] = [];
		registerMagicContextTools(
			{
				registerTool: (tool: unknown) => tools.push(tool),
				registerCommand: () => undefined,
			} as never,
			{ db, todowriteEnabled: false },
		);
		const extensionTool = tools.find(
			(value) => (value as { name: string }).name === "ctx_reduce",
		) as {
			name: string;
			execute: (...args: unknown[]) => Promise<unknown>;
		};
		// The coding-agent extension runner supplies the context as the fifth argument;
		// pi-agent-core invokes its registered tools with four arguments.
		const tool = {
			...extensionTool,
			execute: (
				id: string,
				args: unknown,
				signal: AbortSignal,
				onUpdate: unknown,
			) =>
				extensionTool.execute(id, args, signal, onUpdate, {
					cwd: process.cwd(),
					sessionManager: { getSessionId: () => sessionId },
				}),
		};
		const call = {
			type: "toolCall",
			id: "call-reduce",
			name: "ctx_reduce",
			arguments: { drop },
		};
		let turn = 0;
		const streamFn = async () => {
			const message = {
				role: "assistant",
				content: turn++ === 0 ? [call] : [{ type: "text", text: "done" }],
				stopReason: "stop",
			};
			return {
				async *[Symbol.asyncIterator]() {
					yield { type: "done" };
				},
				result: async () => message,
			};
		};
		const messages = await runAgentLoop(
			[{ role: "user", content: "reduce" }] as never,
			{ systemPrompt: "", messages: [], tools: [tool] } as never,
			{
				model: { provider: "mock" },
				convertToLlm: async () => [],
			} as never,
			() => undefined,
			undefined,
			streamFn as never,
		);
		return messages.find((message) => message.role === "toolResult");
	} finally {
		closeQuietly(db);
	}
}

describe("Pi extension tool error reporting", () => {
	it("marks an invalid ctx_reduce range as an error without changing its text", async () => {
		const result = await runReduce("via 25");
		expect(result?.isError).toBe(true);
		expect(result?.content).toEqual([
			{
				type: "text",
				text: 'Error: Invalid range syntax. Invalid integer: "via 25"',
			},
		]);
	});

	it("keeps a valid ctx_reduce call successful", async () => {
		const result = await runReduce("1");
		expect(result?.isError).toBe(false);
		expect(result?.content[0]?.type).toBe("text");
		expect((result?.content[0] as { text: string }).text).toContain("§1§");
	});
});
