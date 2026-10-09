import { expect, it } from "bun:test";
import { createTagger } from "@magic-context/core/features/magic-context/tagger";
import { createTransform } from "@magic-context/core/hooks/magic-context/transform";
import { createTestTempDir } from "@magic-context/core/shared/test-temp-dir";
import fixture from "../../../testdata/temporal-session-parity.json";
import { createHostSeams } from "../../plugin/src/v2/hooks/context";
import type { V2Context } from "../../plugin/src/v2/hooks/types";
import {
	clearContextHandlerSession,
	registerPiContextHandler,
} from "./context-handler";
import {
	assistantMessage,
	createFakePi,
	createTestDb,
	fakeContext,
	textOf,
	userMessage,
} from "./test-utils.test";

it("Pi and both OpenCode transforms serve the shared Rust session fixture's exact user bytes", async () => {
	const root = createTestTempDir("temporal-parity-");
	const db = createTestDb();
	const sessionId = "temporal-shared-pi";
	try {
		const messages = fixture.messages.map((row) =>
			row.role === "user"
				? userMessage(row.text, row.created)
				: assistantMessage(row.text, row.completed ?? row.created),
		);
		const fake = createFakePi();
		registerPiContextHandler(fake.pi as never, {
			db,
			protectedTags: 0,
			injection: { temporalAwareness: true, injectionBudgetTokens: 10_000 },
		});
		const handler = fake.handlers.get("context") as (
			event: { messages: unknown[] },
			ctx: unknown,
		) => Promise<{ messages: unknown[] }>;
		const output = await handler(
			{ messages },
			fakeContext(
				sessionId,
				root.dir,
				fixture.messages.map((row) => row.id),
				messages,
			),
		);
		const piBytes = output.messages
			.filter((message) => (message as { role?: string }).role === "user")
			.map((message) => textOf(message as never))
			.filter((text) => !text.startsWith("<session-history"));
		expect(piBytes).toEqual(fixture.served_users);
		for (const runtime of ["OpenCode 1", "OpenCode 2"]) {
			const id = `temporal-shared-${runtime}`;
			const models = new Map([
				[id, { providerID: "anthropic", modelID: "claude-sonnet-4-5" }],
			]);
			const read = Object.assign(() => [], {
				readPage: () => [],
				getCount: () => 0,
			});
			const native = fixture.messages.map((row) => ({
				info: {
					id: row.id,
					role: row.role,
					sessionID: id,
					time: { created: row.created, completed: row.completed },
				},
				parts: [{ type: "text", text: row.text }],
			}));
			const seams =
				runtime === "OpenCode 2"
					? createHostSeams({} as V2Context, read, read, models)
					: {};
			await createTransform({
				...seams,
				db,
				tagger: createTagger(),
				scheduler: { shouldExecute: () => "defer" },
				contextUsageMap: new Map(),
				historyRefreshSessions: new Set(),
				pendingMaterializationSessions: new Set([id]),
				lastHeuristicsTurnId: new Map(),
				experimentalTemporalAwareness: true,
				historianRunnable: false,
				liveModelBySession: models,
				protectedTokens: 0,
			})({}, { messages: native });
			const tsBytes = native
				.filter((message) => message.info.role === "user")
				.map((message) => message.parts[0].text);
			expect(tsBytes).toEqual(piBytes);
			expect(tsBytes).toEqual(fixture.served_users);
		}
	} finally {
		clearContextHandlerSession(sessionId);
		db.close();
		root.cleanup();
	}
});
