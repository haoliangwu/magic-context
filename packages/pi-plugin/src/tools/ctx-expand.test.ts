import { describe, expect, it } from "bun:test";
import { createTagger } from "@magic-context/core/features/magic-context/tagger";
import {
	getRawSessionMessageCount,
	hasRawMessageProvider,
	setRawMessageProvider,
} from "@magic-context/core/hooks/magic-context/read-session-chunk";
import { convertEntriesToRawMessages } from "../read-session-pi";
import {
	assistantToolCall,
	createTestDb,
	fakeContext,
	toolResultMessage,
	userMessage,
} from "../test-utils.test";
import { createCtxExpandTool } from "./ctx-expand";

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
