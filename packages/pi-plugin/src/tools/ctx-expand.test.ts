import { describe, expect, it } from "bun:test";

import { createTestDb, fakeContext } from "../test-utils.test";
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
