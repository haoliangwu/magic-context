import { expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	getOrCreateSessionMeta,
	getTagsBySession,
	updateSessionMeta,
} from "@magic-context/core/features/magic-context/storage";
import type {
	MessageLike,
	TagTarget,
} from "@magic-context/core/hooks/magic-context/tag-messages";
import { toolReclaimDistanceEntries } from "@magic-context/core/hooks/magic-context/tool-reclaim";
import { farBehindToolBookmark } from "@magic-context/core/shared/reclaim-distance";
import {
	clearContextHandlerSession,
	registerPiContextHandler,
	signalPiPendingMaterialization,
} from "./context-handler";
import {
	assistantMessage,
	assistantToolCall,
	createFakePi,
	createTestDb,
	fakeContext,
	toolResultMessage,
	userMessage,
} from "./test-utils.test";
import { tokenizePiMessages } from "./tokenize-pi-messages";
import { createPiTranscript } from "./transcript-pi";

function contextHandler(fake: ReturnType<typeof createFakePi>) {
	const handler = fake.handlers.get("context");
	if (!handler) throw new Error("context handler was not registered");
	return handler;
}

function distance(tail: unknown[]) {
	const transcript = createPiTranscript(
		[
			assistantToolCall("old", "bash", {}, 1),
			toolResultMessage("old", "used result", 2),
			...tail,
		],
		"review",
	);
	const messages = transcript.messages.map((message) => ({
		...message,
		parts: message.parts,
	})) as unknown as MessageLike[];
	const owner = messages.find((message) =>
		message.parts.some(
			(part) => (part as { kind?: string }).kind === "tool_result",
		),
	);
	if (!owner) throw new Error("old output owner was not adapted");
	const part = owner.parts.find(
		(part) => (part as { kind?: string }).kind === "tool_result",
	);
	if (!part) throw new Error("old output part was not adapted");
	const targets = new Map<number, TagTarget>([
		[1, { setContent: () => false, mutationParts: [{ message: owner, part }] }],
	]);
	return toolReclaimDistanceEntries(messages, targets);
}

test("Pi: synthetic wake messages must not age the active task", () => {
	const wakes = Array.from({ length: 3 }, (_, index) => ({
		...userMessage(
			"<system-reminder>Background task finished.</system-reminder>",
			index + 3,
		),
		synthetic: true,
	}));
	expect(farBehindToolBookmark(distance(wakes), 200_000)).toBe(0);
});

test("Pi: newer image results must contribute their local token mass", () => {
	const images = Array.from({ length: 21 }, (_, index) => ({
		role: "toolResult",
		toolCallId: `image-${index}`,
		toolName: "read",
		content: [{ type: "image", data: "", mimeType: "image/png" }],
		timestamp: index + 3,
		isError: false,
	}));
	// Pi's normal tokenizer uses a stable 1,200-token fallback per image.
	expect(tokenizePiMessages(images).toolCall).toBe(25_200);
	expect(farBehindToolBookmark(distance(images), 100_000)).toBe(1);
});

test("Pi distance controls: folded results precede the user; tool-only carriers and summaries are not turns", () => {
	const entries = distance([
		{ role: "compactionSummary", summary: "compacted history", timestamp: 3 },
		toolResultMessage("tail", "only a result", 4),
	]);
	expect(entries.filter((entry) => entry.userTurn)).toHaveLength(0);
	const images = Array.from({ length: 3 }, (_, index) =>
		userMessage(
			[{ type: "image", data: "", mimeType: "image/png" }],
			index + 3,
		),
	);
	const folded = distance(images);
	expect(folded.filter((entry) => entry.userTurn)).toHaveLength(3);
	expect(folded.findIndex((entry) => entry.toolOutputTag === 1)).toBeLessThan(
		folded.findIndex((entry) => entry.userTurn),
	);
	expect(farBehindToolBookmark(folded, 0)).toBe(1);
});

// A multi-call batch may return results in a different order from its calls.
test("Pi: a late result must not be swept by a higher-tag siblings bookmark", async () => {
	const session = "parallel-age-review";
	const dir = join(tmpdir(), "magic-context/age-reclaim-review/pi-parallel");
	mkdirSync(dir, { recursive: true });
	const db = createTestDb();
	const fake = createFakePi();
	registerPiContextHandler(fake.pi as never, {
		db,
		protectedTokens: 1000,
		protectedTags: 1,
		heuristics: {},
	});
	const batch = {
		...assistantToolCall("slow", "bash", { command: "slow" }, 2),
		content: ["slow", "fast", "bulk"].map((id) => ({
			type: "toolCall",
			id,
			name: "bash",
			arguments: { command: id },
		})),
	};
	const source: unknown[] = [
		userMessage("one task", 1),
		batch,
		{
			...toolResultMessage("fast", "fast result ".repeat(800), 3),
			toolName: "bash",
		},
		{
			...toolResultMessage("bulk", "newer content ".repeat(40_000), 4),
			toolName: "bash",
		},
		{
			...toolResultMessage("slow", "slow result ".repeat(800), 5),
			toolName: "bash",
		},
	];
	for (let i = 0; i < 3; i++) {
		source.push(
			assistantToolCall(
				`guard-${i}`,
				"bash",
				{ command: `guard ${i}` },
				6 + i * 2,
			),
			{
				...toolResultMessage(
					`guard-${i}`,
					"guard result ".repeat(800),
					7 + i * 2,
				),
				toolName: "bash",
			},
		);
	}
	const serve = async () => {
		const messages = structuredClone(source);
		const ctx = {
			...fakeContext(
				session,
				dir,
				messages.map((_, i) => `entry-${i}`),
				messages as never,
			),
			model: { provider: "review", id: "review", contextWindow: 200_000 },
			getContextUsage: () => ({
				tokens: 4000,
				percent: 2,
				contextWindow: 200_000,
			}),
		};
		return contextHandler(fake)({ messages } as never, ctx as never);
	};
	try {
		await serve();
		const slow = getTagsBySession(db, session).find(
			(tag) => tag.messageId === "slow",
		);
		expect(slow).toBeDefined();
		expect(slow?.status).toBe("active");
		updateSessionMeta(db, session, { lastResponseTime: Date.now() });
		signalPiPendingMaterialization(session, "system_hash");
		await serve();
		expect(
			getTagsBySession(db, session).find((tag) => tag.messageId === "slow")
				?.status,
		).toBe("active");
	} finally {
		clearContextHandlerSession(session);
		db.close();
	}
}, 30000);

test("Pi: unknown geometry must disable token distance", async () => {
	const session = "unknown-window-age-review";
	const dir = join(tmpdir(), "magic-context/age-reclaim-review/pi-unknown");
	mkdirSync(dir, { recursive: true });
	const db = createTestDb();
	const fake = createFakePi();
	registerPiContextHandler(fake.pi as never, { db, heuristics: {} });
	const messages = [
		userMessage("one task", 1),
		assistantToolCall("old", "bash", { command: "inspect" }, 2),
		{
			...toolResultMessage("old", "payload ".repeat(800), 3),
			toolName: "bash",
		},
		assistantMessage("newer content ".repeat(40_000), 4),
	];
	const ctx = {
		...fakeContext(
			session,
			dir,
			messages.map((_, i) => `entry-${i}`),
			messages,
		),
		model: { provider: "review", id: "unknown" },
		getContextUsage: () => undefined,
	};
	try {
		await contextHandler(fake)({ messages } as never, ctx as never);
		expect(getOrCreateSessionMeta(db, session).toolReclaimWatermark).toBe(0);
	} finally {
		clearContextHandlerSession(session);
		db.close();
	}
}, 30000);
