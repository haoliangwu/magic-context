import { expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import {
	getTagsBySession,
	insertTag,
} from "@magic-context/core/features/magic-context/storage";
import { copySessionStateForClone } from "@magic-context/core/features/magic-context/storage-clone";
import { resetLkgSlotsForTest } from "@magic-context/core/hooks/magic-context/lkg-slot";
import {
	clearContextHandlerSession,
	registerPiContextHandler,
} from "./context-handler";
import {
	clearPiChannel1State,
	getPiChannel1Baseline,
	maybeChannel1ReminderForToolResult,
	setPiChannel1Baseline,
} from "./ctx-reduce-nudge-pi";
import { createPiLkgCoordinator } from "./pi-lkg";
import {
	measurePiTailHygiene,
	refreshPiTailHygieneBaseline,
} from "./tail-hygiene-walk-pi";
import { createFakePi, createTestDb, fakeContext } from "./test-utils.test";

const native = await import(
	new URL("./api/pi-messages.js", import.meta.resolve("@earendil-works/pi-ai"))
		.href
);
const model = {
	id: "review-fixture",
	provider: "review-gateway",
	api: "pi-messages",
	baseUrl: "https://example.invalid",
	contextWindow: 1_000_000,
	maxTokens: 8192,
	input: ["text"],
	reasoning: false,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

async function wire(messages: unknown[]) {
	let captured: string | undefined;
	const stream = native.stream(
		model,
		{ messages },
		{
			apiKey: "synthetic-review-key",
			fetch: async (_url: unknown, init: RequestInit) => {
				captured = String(init.body);
				return new Response("synthetic response", { status: 400 });
			},
		},
	);
	await stream.result();
	expect(captured).toBeDefined();
	return captured;
}

function fixture() {
	const thinking = {
		type: "thinking",
		thinking: "reason",
		thinkingSignature: "original signature",
		metadata: { diagnostic: "original" },
	};
	const messages = [
		{
			role: "assistant",
			api: model.api,
			provider: model.provider,
			model: model.id,
			stopReason: "toolUse",
			timestamp: 1,
			content: [
				thinking,
				{ type: "toolCall", id: "review-call", name: "bash", arguments: {} },
			],
		},
		{ role: "user", content: "continue", timestamp: 2 },
	];
	const hash = () =>
		measurePiTailHygiene({
			messages,
			tags: [],
			protectedTagNumbers: new Set(),
			stableId: (_message, index) => `entry-${index}`,
		}).parts[0].contentHash;
	return { thinking, messages, hash };
}

test("issue 704 review Pi native converter forwards metadata omitted by tail identity", async () => {
	const f = fixture();
	const before = f.hash();
	const beforeWire = await wire(f.messages);
	f.thinking.metadata.diagnostic = "changed provider bytes";
	expect(await wire(f.messages)).not.toBe(beforeWire);
	expect(f.hash()).not.toBe(before);
});

test("issue 704 review Pi provider-visible thinking signature control", async () => {
	const f = fixture();
	const before = f.hash();
	const beforeWire = await wire(f.messages);
	f.thinking.thinkingSignature = "changed signature";
	expect(await wire(f.messages)).not.toBe(beforeWire);
	expect(f.hash()).not.toBe(before);
});

test("issue 704 review Pi delivered reminder survives restart fork recovery and signed hold", async () => {
	const db = createTestDb();
	const session = "review-pi-replay";
	const child = `${session}-fork`;
	const messages: any[] = Array.from({ length: 20 }, (_, index) => ({
		role: "user",
		content: "earlier prompt",
		timestamp: index,
	}));
	messages.push(
		{
			role: "assistant",
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-opus-5-5",
			timestamp: 21,
			stopReason: "toolUse",
			content: [{ type: "toolCall", id: "old", name: "bash", arguments: {} }],
		},
		{
			role: "toolResult",
			toolCallId: "old",
			toolName: "bash",
			timestamp: 22,
			isError: false,
			content: [{ type: "text", text: "data ".repeat(80_000) }],
		},
		{ role: "user", content: "continue", timestamp: 23 },
	);
	insertTag(db, session, "old", "tool", 400_000, 1, 0, "bash", 2, "entry-20");
	const serve = (id: string) => {
		const baseline = refreshPiTailHygieneBaseline({
			messages,
			tags: getTagsBySession(db, id),
			protectedTagNumbers: new Set(),
			protectedTools: {},
			stableId: (_m, i) => `entry-${i}`,
			previous: getPiChannel1Baseline(id),
			cacheBusting: false,
		});
		setPiChannel1Baseline(id, {
			...baseline,
			usableWindow: 1_000_000,
			reducedSinceRefresh: false,
			agentDropsAppliedThisPass: false,
			oldestReclaimableToolTags: [],
		});
	};
	try {
		serve(session);
		const first = maybeChannel1ReminderForToolResult({
			db,
			sessionId: session,
			toolName: "bash",
			content: [{ type: "text", text: "fresh result" }],
		});
		expect(first).not.toBeNull();
		if (!first) throw new Error("fixture did not deliver a reminder");
		const delivered = [{ type: "text", text: "fresh result" }, first];
		const bytes = JSON.stringify(delivered);
		messages.push(
			{
				role: "assistant",
				api: "anthropic-messages",
				provider: "anthropic",
				model: "claude-opus-5-5",
				timestamp: 24,
				stopReason: "toolUse",
				content: [
					{
						type: "thinking",
						thinking: "signed thought",
						thinkingSignature: "signature",
					},
					{ type: "toolCall", id: "saved", name: "bash", arguments: {} },
				],
			},
			{
				role: "toolResult",
				toolCallId: "saved",
				toolName: "bash",
				timestamp: 25,
				isError: false,
				content: delivered,
			},
		);
		clearPiChannel1State(session);
		serve(session);
		expect(
			maybeChannel1ReminderForToolResult({
				db,
				sessionId: session,
				toolName: "bash",
				content: delivered,
			}),
		).toBeNull();
		expect(JSON.stringify(delivered)).toBe(bytes);
		expect(
			copySessionStateForClone(db, session, child, {
				resolveBoundaryOrdinal: () => undefined,
				includeTag: () => true,
				includeMessageId: () => true,
				selectPendingPiMarker: () => null,
			}).kind,
		).toBe("migrated");
		serve(child);
		expect(
			maybeChannel1ReminderForToolResult({
				db,
				sessionId: child,
				toolName: "bash",
				content: delivered,
			}),
		).toBeNull();
		const coordinator = createPiLkgCoordinator(db, (capture) => capture());
		const begin = () =>
			coordinator.beginPass({
				sessionId: child,
				messages,
				entryIds: messages.map((_, i) => `entry-${i}`),
				modelKey: "anthropic/claude-opus-5-5",
				providerKey: "anthropic",
			});
		expect(
			coordinator.captureAppliedPass({
				snapshot: begin(),
				outputMessages: messages,
				outputEntryIds: messages.map((_, i) => `entry-${i}`),
				cacheBusting: false,
			}),
		).toBeDefined();
		resetLkgSlotsForTest();
		const recovered = createPiLkgCoordinator(db).replay(begin());
		expect(recovered.ok).toBe(true);
		if (!recovered.ok) throw new Error(recovered.reason);
		expect(JSON.stringify((recovered.messages.at(-1) as any).content)).toBe(
			bytes,
		);

		const fake = createFakePi();
		registerPiContextHandler(fake.pi as never, {
			db,
			protectedTools: {},
			protectedTokens: 0,
		});
		const scratch = `${process.env.TMPDIR ?? "/tmp"}/magic-context/issue-704-review`;
		mkdirSync(scratch, { recursive: true });
		const context = fakeContext(
			child,
			scratch,
			messages.map((_, i) => `entry-${i}`),
			messages,
		);
		Object.assign(context, {
			model: {
				provider: "anthropic",
				id: "claude-opus-5-5",
				api: "anthropic-messages",
				contextWindow: 1_000_000,
			},
		});
		const handler = fake.handlers.get("context") as any;
		let servedBytes: string | undefined;
		for (let pass = 0; pass < 2; pass++) {
			const result = await handler(
				{ messages: structuredClone(messages) },
				context,
			);
			const saved = result.messages.find(
				(m: any) => m.role === "toolResult" && m.toolCallId === "saved",
			);
			expect(saved.content[1].text.endsWith(first.text)).toBe(true);
			const rendered = JSON.stringify(saved.content);
			// Initial tag assignment adds its normal prefix; a later hold must replay it.
			if (servedBytes !== undefined) expect(rendered).toBe(servedBytes);
			servedBytes = rendered;
		}
	} finally {
		clearContextHandlerSession(session);
		clearContextHandlerSession(child);
		clearPiChannel1State(session);
		clearPiChannel1State(child);
		resetLkgSlotsForTest();
		db.close();
	}
});
