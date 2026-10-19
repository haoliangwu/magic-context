import { expect, it, spyOn } from "bun:test";
import { join } from "node:path";
import {
	getTagsBySession,
	queuePendingOp,
	updateSessionMeta,
} from "@magic-context/core/features/magic-context/storage";
import * as logger from "@magic-context/core/shared/logger";
import { createTestTempDir } from "@magic-context/core/shared/test-temp-dir";
import {
	clearContextHandlerSession,
	registerPiContextHandler,
} from "./context-handler";
import {
	clearPiUpperReclaimSession,
	piUpperReclaimCursor,
	recordPiUpperEstimateReclaim,
} from "./pi-fit-reclaim";
import {
	classifyPiOutgoingFit,
	estimatePiOutgoingInputTokens,
} from "./pi-raw-fallback";
import {
	assistantMessage,
	createFakePi,
	createTestDb,
	fakeContext,
	toolResultMessage,
	userMessage,
} from "./test-utils.test";

// Enable MC_689_REVIEW=1 to check that oversized messages are refused and size
// estimates cannot start a rebuild on defer or more than once per session.
// These currently fail and are excluded from normal package runs.
const review = process.env.MC_689_REVIEW === "1" ? it : it.skip;

const metadataNotice = (timestamp: number) => ({
	role: "custom",
	customType: "notice",
	timestamp,
	content: [
		{ type: "text", text: "small visible notice" },
		{ type: "extension-metadata", details: "x".repeat(1_000_000) },
	],
});

function fixture(
	sessionId: string,
	model = { provider: "mock", id: "mock", contextWindow: 50000 },
) {
	const db = createTestDb();
	const fake = createFakePi();
	Object.assign(fake.pi, { getAllTools: () => [] });
	registerPiContextHandler(fake.pi as never, {
		db,
		protectedTags: 0,
		injection: {
			injectionBudgetTokens: 10000,
			injectDocs: false,
			memoryEnabled: false,
		},
	});
	const handler = fake.handlers.get("context") as (
		event: { messages: never[] },
		ctx: never,
	) => Promise<{ messages: unknown[] }>;
	return {
		db,
		async pass(source: unknown[], inputTokens = 1000) {
			const messages = structuredClone(source);
			return handler({ messages: messages as never[] }, {
				...fakeContext(
					sessionId,
					process.cwd(),
					messages.map((_, index) => `entry-${index}`),
					messages as never[],
				),
				hasUI: false,
				getSystemPrompt: () => "You are helpful.",
				model,
				getContextUsage: () => ({
					tokens: inputTokens,
					percent: (inputTokens / 50000) * 100,
					contextWindow: 50000,
				}),
			} as never);
		},
		settle(inputTokens = 1000) {
			updateSessionMeta(db, sessionId, {
				lastResponseTime: Date.now(),
				lastInputTokens: inputTokens,
				lastContextPercentage: (inputTokens / 50000) * 100,
			});
		},
		close() {
			clearContextHandlerSession(sessionId);
			db.close();
		},
	};
}

function captureLogs() {
	const lines: string[] = [];
	const spy = spyOn(logger, "sessionLog").mockImplementation(
		(_sessionId, ...parts) => {
			lines.push(parts.join(" "));
		},
	);
	return { lines, restore: () => spy.mockRestore() };
}

review(
	"review 689: upper-only reclaim must not originate a bust on a low-pressure defer",
	async () => {
		const f = fixture("review-689-defer");
		const logs = captureLogs();
		try {
			await f.pass([userMessage("initial", 1)]);
			f.settle();
			const original = getTagsBySession(f.db, "review-689-defer").find(
				(tag) => tag.messageId === "entry-0:p0",
			);
			if (!original) throw new Error("initial user tag missing");
			queuePendingOp(f.db, "review-689-defer", original.tagNumber, "drop");
			logs.lines.length = 0;
			await f.pass([
				userMessage("initial", 1),
				metadataNotice(2),
				userMessage("continue", 3),
			]);
			expect(logs.lines.some((line) => /decision=defer/.test(line))).toBe(true);
			const transform = logs.lines.find((line) => line.includes("transform:"));
			expect(transform).not.toContain("force=true");
			expect(transform).not.toContain("busting=true");
			console.log("review defer scheduler", transform);
			const reclaims = logs.lines.filter((line) =>
				line.includes("upper-estimate-pressure; attempting emergency reclaim"),
			);
			console.log(
				"review defer old-tag status",
				getTagsBySession(f.db, "review-689-defer").find(
					(tag) => tag.tagNumber === original.tagNumber,
				)?.status,
			);
			expect(reclaims).toHaveLength(0);
		} finally {
			logs.restore();
			f.close();
		}
	},
);

review(
	"review 689: appending ordinary content must not rearm a session's used upper-only latch",
	async () => {
		const f = fixture("review-689-appended-latch");
		const logs = captureLogs();
		try {
			const source = [metadataNotice(1), userMessage("continue", 2)];
			await f.pass(source, 0);
			f.settle(0);
			await f.pass([...source, userMessage("another small prompt", 3)], 0);
			const reclaims = logs.lines.filter((line) =>
				line.includes("upper-estimate-pressure; attempting emergency reclaim"),
			);
			expect(reclaims).toHaveLength(1);
		} finally {
			logs.restore();
			f.close();
		}
	},
);

review(
	"review 689: a headless text-plus-image request proven oversized must refuse, not send",
	async () => {
		const f = fixture("review-689-image-proof");
		const source = [
			userMessage([
				{ type: "text", text: "word ".repeat(100000) },
				{
					type: "image",
					mimeType: "image/png",
					data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
				},
			]),
		];
		try {
			const estimate = estimatePiOutgoingInputTokens(
				source,
				{ modelKey: "mock/mock", systemTokens: 10, toolDefinitionTokens: 0 },
				undefined,
				50000,
			);
			console.log(
				"review image fit classification",
				classifyPiOutgoingFit(estimate, 50000),
			);
			const outcomes = [];
			for (const attempt of ["cold", "latch-used", "cache-reset"]) {
				if (attempt === "cache-reset")
					clearContextHandlerSession("review-689-image-proof");
				let refused = false;
				let visibleBytes = 0;
				try {
					const result = await f.pass(source, 0);
					for (const raw of result.messages) {
						const message = raw as {
							content?: string | { type: string; text?: string }[];
						};
						if (typeof message.content === "string")
							visibleBytes += Buffer.byteLength(message.content);
						else
							for (const part of message.content ?? [])
								if (part.type === "text")
									visibleBytes += Buffer.byteLength(part.text ?? "");
					}
				} catch (error) {
					if (!String(error).includes("this turn was not sent")) throw error;
					refused = true;
				}
				outcomes.push({
					attempt,
					refused,
					visibleTextMinimum: Math.ceil(visibleBytes / 4),
					window: 50000,
				});
				f.settle(0);
			}
			console.log("review image outcomes", outcomes);
			expect(
				outcomes.every(
					(row) => row.refused || row.visibleTextMinimum <= row.window,
				),
			).toBe(true);
		} finally {
			f.close();
		}
	},
);

review(
	"review 689: an already-running Pi process must observe another process's latch claim",
	async () => {
		const { dir } = createTestTempDir("review-689-processes-");
		const path = join(dir, "review.db");
		const sessionId = "review-689-cross-process";
		const db = createTestDb(path);
		const child = Bun.spawn(
			[
				process.execPath,
				"src/fixtures/issue-689-cursor-worker.ts",
				path,
				sessionId,
			],
			{
				stdin: "pipe",
				stdout: "pipe",
				stderr: "pipe",
				env: { ...process.env },
				windowsHide: true,
			},
		);
		try {
			const reader = child.stdout.getReader();
			const first = await reader.read();
			expect(new TextDecoder().decode(first.value)).toContain("READY:true");
			const cursor = piUpperReclaimCursor({
				sessionId,
				modelKey: "mock/mock",
				messageCount: 1,
				input: [userMessage("unchanged", 1)],
			});
			if (!cursor) throw new Error("fixture cursor missing");
			recordPiUpperEstimateReclaim(db, cursor);
			child.stdin.end();
			let rest = "";
			for (;;) {
				const next = await reader.read();
				if (next.done) break;
				rest += new TextDecoder().decode(next.value);
			}
			expect(await child.exited).toBe(0);
			expect(await new Response(child.stderr).text()).toBe("");
			expect(rest).toContain("CLAIM:false");
		} finally {
			child.kill();
			clearPiUpperReclaimSession(sessionId);
			db.close();
		}
	},
);

it("review 689: upper-only pressure keeps an unfinished signed-thinking turn below force", async () => {
	const f = fixture("review-689-signed-upper", {
		provider: "anthropic",
		id: "claude-opus-5-5",
		contextWindow: 50000,
	});
	const logs = captureLogs();
	try {
		const initial = [userMessage("initial", 1), assistantMessage("done", 2)];
		await f.pass(initial);
		f.settle();
		const source = [
			...initial,
			metadataNotice(3),
			userMessage("next", 4),
			assistantMessage("", 5, {
				provider: "anthropic",
				model: "claude-opus-5-5",
				api: "anthropic-messages",
				content: [
					{
						type: "thinking",
						thinking: "active thought",
						thinkingSignature: "review-signature",
					},
					{
						type: "toolCall",
						id: "call-1",
						name: "Read",
						arguments: { path: "a.ts" },
					},
				],
			}),
			toolResultMessage("call-1", "small result", 6),
		];
		logs.lines.length = 0;
		const first = await f.pass(source);
		f.settle();
		const second = await f.pass(source);
		expect(JSON.stringify(first.messages)).toContain("review-signature");
		expect(JSON.stringify(second.messages)).toBe(
			JSON.stringify(first.messages),
		);
		expect(
			logs.lines.some((line) => line.includes("reclaim held by signed prefix")),
		).toBe(true);
		expect(
			logs.lines.filter((line) =>
				line.includes("attempting emergency reclaim"),
			),
		).toHaveLength(0);
	} finally {
		logs.restore();
		f.close();
	}
});
