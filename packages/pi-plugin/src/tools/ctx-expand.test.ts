import { describe, expect, it } from "bun:test";
import { appendCompartments } from "@magic-context/core/features/magic-context/compartment-storage";
import { createTagger } from "@magic-context/core/features/magic-context/tagger";
import {
	getRawSessionMessageCount,
	hasRawMessageProvider,
	setRawMessageProvider,
} from "@magic-context/core/hooks/magic-context/read-session-chunk";
import { clearPiOrdinalAlignmentSession } from "../pi-ordinal-alignment";
import { convertEntriesToRawMessages } from "../read-session-pi";
import {
	assistantToolCall,
	createTestDb,
	fakeContext,
	toolResultMessage,
	userMessage,
} from "../test-utils.test";
import { createCtxExpandTool } from "./ctx-expand";
import { createCtxSearchTool } from "./ctx-search";

async function execute(params: {
	message?: number;
	start?: number;
	end?: number;
	verbose?: boolean;
}) {
	const db = createTestDb();
	try {
		return await createCtxExpandTool({ db }).execute(
			"call-expand",
			params,
			new AbortController().signal,
			undefined,
			fakeContext("ses-expand-integers") as never,
		);
	} finally {
		db.close();
	}
}

function textOf(result: Awaited<ReturnType<typeof execute>>): string {
	return (result.content[0] as { text: string }).text;
}

it("Pi search citation survives a branch prefix loss starting at message 62733", async () => {
	const db = createTestDb();
	const sessionId = "ses-pi-archive-prefix";
	const ctx = fakeContext(
		sessionId,
		process.cwd(),
		["live-user", "live-answer"],
		[
			userMessage("unrelated live message", 1),
			{
				role: "assistant",
				content: [{ type: "text", text: "surviving answer" }],
				timestamp: 2,
			},
		],
	);
	try {
		appendCompartments(db, sessionId, [
			{
				sequence: 1,
				startMessage: 62733,
				endMessage: 62734,
				startMessageId: "live-user",
				endMessageId: "live-answer",
				title: "survivors",
				content: "Summary",
				p1: "Summary",
			},
		]);
		// A retained, unmapped FTS row also models older stores before sidecar backfill.
		db.prepare(
			"INSERT INTO message_history_fts(session_id, message_ordinal, message_id, role, content) VALUES (?, ?, ?, ?, ?)",
		).run(
			sessionId,
			5796,
			"archived-sender",
			"user",
			"ckdev-mutate 0.9.2 was sent by Ada",
		);
		const search = createCtxSearchTool({
			db,
			memoryEnabled: false,
			embeddingEnabled: false,
			gitCommitsEnabled: false,
		});
		const found = textOf(
			await search.execute(
				"search",
				{ query: "ckdev-mutate", sources: ["message"], limit: 4 },
				new AbortController().signal,
				undefined,
				ctx as never,
			),
		);
		expect(found).toContain("ordinal=5796 range=5793-5799");
		expect(found).toContain(
			"search archive only, with no surrounding messages",
		);
		const expand = createCtxExpandTool({ db });
		for (const params of [
			{ start: 5788, end: 5799 },
			{ start: 5788, end: 5799, verbose: true },
			{ message: 5796 },
		]) {
			const text = textOf(
				await expand.execute(
					"expand",
					params,
					new AbortController().signal,
					undefined,
					ctx as never,
				),
			);
			expect(text).toStartWith("From the search archive:");
			expect(text).toContain("[5796] U: ckdev-mutate 0.9.2 was sent by Ada");
			expect(text).not.toContain("unrelated live message");
			expect(text).not.toContain("No messages found");
		}
		const missing = textOf(
			await expand.execute(
				"expand",
				{ message: 5795 },
				new AbortController().signal,
				undefined,
				ctx as never,
			),
		);
		expect(missing).toContain("history, which now starts at message 62733");
		const unanchored = fakeContext(
			sessionId,
			process.cwd(),
			["different-branch"],
			[userMessage("wrong branch text", 1)],
		);
		const recovered = textOf(
			await expand.execute(
				"expand",
				{ start: 5788, end: 5799 },
				new AbortController().signal,
				undefined,
				unanchored as never,
			),
		);
		expect(recovered).toContain("[5796] U: ckdev-mutate 0.9.2 was sent by Ada");
		expect(recovered).not.toContain("wrong branch text");
	} finally {
		clearPiOrdinalAlignmentSession(sessionId);
		db.close();
	}
});

describe("Pi ctx_expand verbose range", () => {
	it("labels consecutive toolResult entries separately from real user text", async () => {
		const messages = [
			userMessage("Read PLAN.md", 1),
			assistantToolCall("call-1", "Read", { path: "PLAN.md" }),
			toolResultMessage("call-1", "file contents"),
			toolResultMessage("call-2", "more contents"),
			assistantToolCall("call-3", "Read", { path: "next.md" }),
			toolResultMessage("call-3", "next contents"),
			userMessage("Continue", 7),
		];
		const db = createTestDb();
		try {
			const ctx = fakeContext(
				"ses-pi-verbose-results",
				process.cwd(),
				messages.map((_, i) => `entry-${i}`),
				messages,
			);
			const result = await createCtxExpandTool({ db }).execute(
				"call-expand",
				{ start: 1, end: 5, verbose: true },
				new AbortController().signal,
				undefined,
				ctx as never,
			);
			const text = textOf(result);
			expect(text).toMatch(/^\[1\] U \(user\)\n {4}• Read PLAN.md/m);
			expect(text).toMatch(/^\[2\] A \(assistant\)/m);
			expect(text).toMatch(
				/^\[3\] tool results\n {4}• tool Read → output ~\d+ tok\n {4}• tool Read → output ~\d+ tok/m,
			);
			expect(text).toMatch(/^\[4\] A \(assistant\)/m);
			expect(text).toMatch(
				/^\[5\] U \(user\)\n {4}• tool Read → output ~\d+ tok\n {4}• Continue/m,
			);
		} finally {
			db.close();
		}
	});
});

describe("Pi ctx_expand ordinal validation", () => {
	it("rejects fractional message and range ordinals", async () => {
		const byMessage = await execute({ message: 1.5 });
		expect(byMessage.isError).toBe(true);
		expect(textOf(byMessage)).toBe(
			"Error: message must be a positive integer.",
		);

		const byRange = await execute({ start: 1.5, end: 2 });
		expect(byRange.isError).toBe(true);
		expect(textOf(byRange)).toBe(
			"Error: provide either message=<ordinal>, or start and end (positive integers, start <= end).",
		);
	});
});

describe("Pi ctx_expand required-all filler", () => {
	it("matches the clean call for every mode when unused fields are filled", async () => {
		const rangeClean = await execute({ start: 1, end: 3 });
		const rangeFiller = await execute({
			start: 1,
			end: 3,
			message: 0,
			verbose: false,
		});
		const verboseClean = await execute({ start: 1, end: 3, verbose: true });
		const verboseFiller = await execute({
			start: 1,
			end: 3,
			verbose: true,
			message: 0,
		});
		const messageClean = await execute({ message: 2 });
		const messageFiller = await execute({
			message: 2,
			start: 0,
			end: 0,
			verbose: false,
		});

		expect(textOf(rangeFiller)).toBe(textOf(rangeClean));
		expect(textOf(verboseFiller)).toBe(textOf(verboseClean));
		expect(textOf(messageFiller)).toBe(textOf(messageClean));
		expect(rangeFiller.isError).toBe(rangeClean.isError);
		expect(verboseFiller.isError).toBe(verboseClean.isError);
		expect(messageFiller.isError).toBe(messageClean.isError);
		expect(textOf(rangeClean)).toContain("No messages found in range 1-3");
		expect(textOf(messageClean)).toContain("No message at ordinal 2");
	});
});

it("Pi tag recovery pairs the raw invocation and result without returning siblings", async () => {
	const db = createTestDb();
	const sessionId = "ses-pi-tag";
	const messages = [
		userMessage("original text", 1),
		assistantToolCall("call-1", "Read", { path: "PLAN.md" }),
		toolResultMessage("call-1", "original output"),
	];
	const ctx = fakeContext(
		sessionId,
		process.cwd(),
		["entry-0", "entry-1", "entry-2"],
		messages,
	);
	const tagger = createTagger();
	tagger.assignTag(sessionId, "entry-0:p0", "message", 10, db);
	tagger.assignToolTag(sessionId, "call-1", "entry-1", 10, db);
	try {
		const tool = createCtxExpandTool({ db });
		const call = (tag: number | string) =>
			tool.execute(
				"expand",
				{ tag },
				new AbortController().signal,
				undefined,
				ctx as never,
			);
		expect(textOf(await call("§1§"))).toContain("original text");
		const result = textOf(await call("tag 2"));
		expect(result).toContain("PLAN.md");
		expect(result).toContain("original output");
		expect(textOf(await call(99))).toContain("no tag 99 in this session");
	} finally {
		db.close();
	}
});

it("leaves a background reader's raw-message provider in place", async () => {
	const db = createTestDb();
	const sessionId = "ses-pi-expand-shared-provider";
	const messages = [userMessage("hello", 1), userMessage("again", 2)];
	const ctx = fakeContext(
		sessionId,
		process.cwd(),
		["entry-0", "entry-1"],
		messages,
	);
	// A background historian or recomp registers its own source and keeps
	// reading through it after this tool call returns.
	const background = {
		readMessages: () => convertEntriesToRawMessages([]),
		getMessageCount: () => 41,
	};
	const unregisterBackground = setRawMessageProvider(sessionId, background);
	try {
		const result = await createCtxExpandTool({ db }).execute(
			"expand",
			{ start: 1, end: 2 },
			new AbortController().signal,
			undefined,
			ctx as never,
		);
		expect(result.content).toHaveLength(1);

		expect(hasRawMessageProvider(sessionId)).toBe(true);
		expect(getRawSessionMessageCount(sessionId)).toBe(41);
	} finally {
		unregisterBackground();
		db.close();
	}
});
