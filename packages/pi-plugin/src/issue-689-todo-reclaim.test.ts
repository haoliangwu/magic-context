import { expect, it, spyOn } from "bun:test";
import { updateSessionMeta } from "@magic-context/core/features/magic-context/storage";
import { getPersistedTodoSyntheticAnchor } from "@magic-context/core/features/magic-context/storage-meta";
import { computeSyntheticCallId } from "@magic-context/core/hooks/magic-context/todo-view";
import * as logger from "@magic-context/core/shared/logger";
import {
	clearContextHandlerSession,
	registerPiContextHandler,
} from "./context-handler";
import {
	assistantMessage,
	createFakePi,
	createTestDb,
	fakeContext,
	userMessage,
} from "./test-utils.test";

it("native Pi fit reclaim preserves the synthetic todowrite pair", async () => {
	const db = createTestDb();
	const sessionId = "pi-fit-reclaim-todo";
	const fake = createFakePi();
	Object.assign(fake.pi, { getAllTools: () => [] });
	const lines: string[] = [];
	const log = spyOn(logger, "sessionLog").mockImplementation(
		(_id, ...parts) => {
			lines.push(parts.join(" "));
		},
	);
	registerPiContextHandler(fake.pi as never, {
		db,
		protectedTags: 0,
		todowriteEnabled: true,
		injection: { injectionBudgetTokens: 10000 },
	});
	const handler = fake.handlers.get("context") as (
		event: { messages: never[] },
		ctx: never,
	) => Promise<{ messages: unknown[] }>;
	const pass = async (includeMetadata: boolean) => {
		const messages: unknown[] = [
			userMessage("start", 1),
			assistantMessage("working", 2),
		];
		const entryIds = ["u1", "a1"];
		if (includeMetadata) {
			// The conservative request-size estimate includes extension metadata
			// even when provider serializers omit it. This triggers a reclaim retry
			// without adding genuinely oversized visible text.
			messages.push({
				role: "custom",
				customType: "notice",
				timestamp: 3,
				content: [{ type: "extension-metadata", details: "x".repeat(1000000) }],
			});
			entryIds.push("notice");
		}
		messages.push(userMessage("continue", 4));
		entryIds.push("u2");
		return handler({ messages: messages as never[] }, {
			...fakeContext(sessionId, process.cwd(), entryIds, messages as never[]),
			hasUI: false,
			getSystemPrompt: () => "You are helpful.",
			model: { provider: "mock", id: "mock", contextWindow: 100000 },
		} as never);
	};
	const todos = [
		{ content: "Build feature", status: "in_progress", priority: "high" },
	];
	const stateJson = JSON.stringify(todos);
	const callId = computeSyntheticCallId(stateJson);
	const pair = (messages: unknown[]) => {
		const index = messages.findIndex((message) => {
			const m = message as { role?: string; content?: Array<{ id?: string }> };
			return (
				m.role === "assistant" && m.content?.some((part) => part.id === callId)
			);
		});
		expect(index).toBeGreaterThanOrEqual(0);
		const assistant = messages[index] as { content: unknown[] };
		expect(assistant.content).toContainEqual({
			type: "toolCall",
			id: callId,
			name: "todowrite",
			arguments: { todos },
			syntheticTodoMarker: true,
		});
		expect(messages[index + 1]).toMatchObject({
			role: "toolResult",
			toolCallId: callId,
			toolName: "todowrite",
			syntheticTodoMarker: true,
		});
		return JSON.stringify(messages.slice(index, index + 2));
	};
	try {
		await pass(false);
		updateSessionMeta(db, sessionId, {
			lastResponseTime: Date.now(),
			lastInputTokens: 80000,
			lastContextPercentage: 80,
			lastTodoState: stateJson,
		});
		const result = await pass(true);
		expect(
			lines.filter((line) => line.includes("attempting emergency reclaim")),
		).toHaveLength(1);
		expect(getPersistedTodoSyntheticAnchor(db, sessionId)).toEqual({
			callId,
			messageId: "pi-ts-2",
			stateJson,
		});
		const servedPair = pair(result.messages);
		updateSessionMeta(db, sessionId, {
			lastResponseTime: Date.now(),
			lastInputTokens: 1000,
			lastContextPercentage: 1,
		});
		const replay = await pass(true);
		expect(pair(replay.messages)).toBe(servedPair);
		expect(
			lines.filter((line) => line.includes("attempting emergency reclaim")),
		).toHaveLength(1);
	} finally {
		log.mockRestore();
		clearContextHandlerSession(sessionId);
		db.close();
	}
});
