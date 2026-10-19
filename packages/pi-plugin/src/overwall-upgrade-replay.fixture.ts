import {
	getTagsBySession,
	updateSessionMeta,
	updateTagDropMode,
	updateTagStatus,
} from "@magic-context/core/features/magic-context/storage";
import {
	clearContextHandlerSession,
	registerPiContextHandler,
} from "./context-handler";
import {
	assistantMessage,
	createFakePi,
	createTestDb,
	fakeContext,
	toolResultMessage,
	userMessage,
} from "./test-utils.test";

export function fixture(
	native: boolean,
	count = 200,
	db = createTestDb(),
	session = `review-${native}`,
	remap = false,
) {
	const fake = createFakePi();
	const model = {
		id: "native-upgrade-codex",
		api: "openai-codex-responses",
		provider: "openai-codex",
		contextWindow: 100000,
		compat: {
			requiresReasoningContentForAllAssistantTurns: false,
			requiresReasoningContentForToolCalls: false,
		},
	};
	const source = [
		userMessage("first", 1),
		...Array.from({ length: count }, (_, i) => [
			assistantMessage("", 2 + i * 2, {
				api: model.api,
				provider: model.provider,
				model: model.id,
				content: [
					{
						type: "toolCall",
						id: `call-${i}|fc-${i}`,
						name: "read",
						arguments: { path: `original-${i}` },
					},
				],
				...(native
					? {
							providerPayload: {
								type: "openaiResponsesHistory",
								items: [
									{
										type: "function_call",
										id: `fc-${i}`,
										call_id: `call-${i}`,
										name: "read",
										arguments: JSON.stringify({ path: `original-${i}` }),
									},
								],
							},
						}
					: {}),
			}),
			toolResultMessage(`call-${i}|fc-${i}`, `output-${i}`, 3 + i * 2),
		]).flat(),
		userMessage("continue", 1000),
	];
	const ids = source.map((_, i) => `${remap ? "clone-" : ""}entry-${i}`);
	const restart = () => {
		clearContextHandlerSession(session);
		registerPiContextHandler(fake.pi as never, {
			db,
			heuristics: { clearReasoningAge: 100 },
			scheduler: { executeThresholdPercentage: 80 },
		});
	};
	restart();
	const pass = async (percent: number) => {
		updateSessionMeta(db, session, {
			lastResponseTime: Date.now(),
			cacheTtl: "59m",
		});
		const messages = structuredClone(source);
		const handler = fake.handlers.get("context") as unknown as (
			input: { messages: unknown[] },
			ctx: unknown,
		) => Promise<{ messages: unknown[] }>;
		const out = await handler(
			{ messages },
			{
				...fakeContext(session, process.cwd(), ids, messages),
				model,
				getContextUsage: () => ({
					percent,
					tokens: percent * 1000,
					contextWindow: 100000,
				}),
			},
		);
		return out.messages;
	};
	const seed = async () => {
		await pass(0);
		for (const t of getTagsBySession(db, session))
			if (t.type === "tool") {
				updateTagStatus(db, session, t.tagNumber, "dropped");
				updateTagDropMode(db, session, t.tagNumber, "full");
			}
	};
	return {
		db,
		session,
		source,
		ids,
		pass,
		seed,
		restart,
		close: () => {
			clearContextHandlerSession(session);
			db.close();
		},
	};
}

type TranscriptMessage = { role: string; content?: Array<{ type: string }> };
export const calls = (messages: unknown[]) =>
	(messages as TranscriptMessage[]).flatMap((message) =>
		message.role === "assistant"
			? (message.content ?? []).filter((part) => part.type === "toolCall")
			: [],
	).length;
