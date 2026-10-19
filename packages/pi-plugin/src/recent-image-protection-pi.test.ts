import { expect, test } from "bun:test";
import { getProcessedImageStrippedIds } from "@magic-context/core/features/magic-context/storage";
import { stripPiProcessedImages } from "./strip-processed-images-pi";
import {
	assistantMessage,
	assistantToolCall,
	createTestDb,
	userMessage,
} from "./test-utils.test";

const image = () => ({
	type: "image",
	mimeType: "image/png",
	data: "a".repeat(240),
});
const stableId = (message: unknown) =>
	`entry-${(message as { timestamp: number }).timestamp}`;
const userImage = () => userMessage([image()], 2);

type Options = Partial<Parameters<typeof stripPiProcessedImages>[0]>;
function run(options: Options = {}) {
	const db = createTestDb();
	try {
		const messages: unknown[] = options.messages ?? [
			userImage(),
			assistantMessage("answered", 3),
		];
		const before = structuredClone(messages);
		const result = stripPiProcessedImages({
			db,
			sessionId: "recent-images",
			messages,
			detect: true,
			watermark: 5,
			messageIdToMaxTag: new Map([["entry-2", 3]]),
			stableId,
			...options,
		});
		expect(result.stripped > 0).toBe(
			JSON.stringify(messages) !== JSON.stringify(before),
		);
		expect(getProcessedImageStrippedIds(db, "recent-images").size).toBe(
			result.newlyStrippedIds.length,
		);
		return result.stripped;
	} finally {
		db.close();
	}
}

test("recent-image position: own positive tag wins, otherwise only the next positive message tag supplies age", () => {
	expect(
		run({
			messageIdToMaxTag: new Map([
				["entry-2", 3],
				["entry-3", 9],
			]),
		}),
	).toBe(1);
	expect(
		run({
			messageIdToMaxTag: new Map([
				["entry-2", 9],
				["entry-3", 3],
			]),
		}),
	).toBe(0);
	expect(run({ messageIdToMaxTag: new Map([["entry-3", 3]]) })).toBe(1);
	expect(run({ messageIdToMaxTag: new Map([["entry-3", 9]]) })).toBe(0);
	expect(
		run({
			messages: [
				userMessage("old", 1),
				userImage(),
				assistantMessage("answer", 3),
			],
			messageIdToMaxTag: new Map([["entry-1", 1]]),
		}),
	).toBe(0);
	expect(run({ messageIdToMaxTag: new Map() })).toBe(0);
	expect(
		run({
			messages: [
				userImage(),
				userMessage("untagged", 3),
				assistantMessage("answer", 4),
			],
			messageIdToMaxTag: new Map([
				["entry-3", 0],
				["entry-4", 3],
			]),
		}),
	).toBe(1);
});

test("recent-image age: positive watermark, later answer, admitted discovery and stable id remain mandatory", () => {
	expect(run()).toBe(1);
	expect(run({ watermark: 0 })).toBe(0);
	expect(run({ watermark: 2 })).toBe(0);
	expect(run({ messages: [assistantMessage("earlier", 1), userImage()] })).toBe(
		0,
	);
	expect(run({ detect: false })).toBe(0);
	expect(run({ stableId: () => undefined })).toBe(0);
});

test("recent-image protected range: cutoff and newer positions stay intact below 95 percent", () => {
	expect(run({ protectedCutoff: 3, usagePercentage: 94.99 })).toBe(0);
	expect(run({ protectedCutoff: 2, usagePercentage: 90 })).toBe(0);
	expect(run({ protectedCutoff: 4, usagePercentage: 90 })).toBe(1);
	expect(
		run({ protectedCutoff: 3, messageIdToMaxTag: new Map([["entry-3", 3]]) }),
	).toBe(0);
});

test("recent-image emergency: 95 percent waives only the range, not tool protection, pairing, answer or age", () => {
	expect(run({ protectedCutoff: 3, usagePercentage: 95 })).toBe(1);
	expect(run({ protectedCutoff: 3, usagePercentage: 95, watermark: 2 })).toBe(
		0,
	);
	expect(
		run({ protectedCutoff: 3, usagePercentage: 95, messages: [userImage()] }),
	).toBe(0);
	const result = {
		role: "toolResult",
		toolCallId: "shot",
		timestamp: 2,
		content: [image()],
	};
	const messages = [
		assistantToolCall("shot", "screenshot", {}, 1),
		result,
		assistantMessage("answer", 3),
	];
	expect(
		run({
			messages: structuredClone(messages),
			usagePercentage: 95,
			protectedCutoff: 1,
		}),
	).toBe(1);
	expect(
		run({
			messages: structuredClone(messages),
			usagePercentage: 95,
			protectedToolKeys: new Set(["entry-1\x00shot"]),
		}),
	).toBe(0);
	expect(
		run({
			messages: [result, assistantMessage("answer", 3)],
			usagePercentage: 95,
		}),
	).toBe(0);
	expect(
		run({
			messages: [assistantToolCall("shot", "screenshot", {}, 1)],
			usagePercentage: 95,
		}),
	).toBe(0);
});

test("recent-image frozen replay ignores subsequent cutoff, watermark and discovery changes", () => {
	const db = createTestDb();
	try {
		const build = () => [userImage(), assistantMessage("answered", 3)];
		const first = build();
		stripPiProcessedImages({
			db,
			sessionId: "replay",
			messages: first,
			detect: true,
			watermark: 5,
			messageIdToMaxTag: new Map([["entry-2", 3]]),
			stableId,
			protectedCutoff: 3,
			usagePercentage: 95,
		});
		expect(JSON.stringify(first)).toContain("[image stripped]");
		const deferred = build();
		const result = stripPiProcessedImages({
			db,
			sessionId: "replay",
			messages: deferred,
			detect: false,
			watermark: 0,
			messageIdToMaxTag: new Map(),
			stableId,
			protectedCutoff: 0,
			usagePercentage: 10,
		});
		expect(result).toEqual({ stripped: 1, newlyStrippedIds: [] });
		expect(deferred).toEqual(first);
	} finally {
		db.close();
	}
});
