import { expect, test } from "bun:test";
import { join } from "node:path";
import { sessionDecisionCalibration } from "@magic-context/core/features/magic-context/session-decision-calibration";
import { openDatabase } from "@magic-context/core/features/magic-context/storage-db";
import {
	getOrCreateSessionMeta,
	updateSessionMeta,
} from "@magic-context/core/features/magic-context/storage-meta-session";
import {
	addNativeReasoningIds,
	getNativeReplayState,
} from "@magic-context/core/features/magic-context/storage-native-replay";
import { setHarness } from "@magic-context/core/shared/harness";
import {
	Database,
	withSqliteTransformPass,
} from "@magic-context/core/shared/sqlite";
import { createTestTempDir } from "@magic-context/core/shared/test-temp-dir";
import {
	clearOldReasoningPi,
	piMessageStableId,
	piReasoningClearCutoff,
	replayClearedReasoningPi,
	stripInlineThinkingPi,
} from "./reasoning-replay-pi";

setHarness("pi");

function fixture(countReads = false) {
	let reads = 0;
	const messages: Record<string, unknown>[] = [
		{ role: "user", content: "start" },
	];
	const tags = new Map<string, number>();
	const gone = new Set<string>();
	let watermark = 0;
	for (let arc = 0; arc < 9250; arc++) {
		const message = {
			role: "assistant",
			usage: { reasoning: 100 },
			content: [
				...(arc >= 2127
					? [
							{
								type: "thinking",
								thinking: "tool reasoning",
								thinkingSignature: "sig",
							},
						]
					: []),
				{ type: "text", text: "reply" },
				{ type: "toolCall", id: `call-${arc}`, name: "read", arguments: {} },
			],
		};
		const id = piMessageStableId(message, messages.length);
		if (!id) throw new Error("missing fixture id");
		const tag = 39767 + arc * 2;
		tags.set(id, tag);
		if (arc >= 2127 && arc < 9127) {
			gone.add(id);
			watermark = tag;
		}
		messages.push(message);
		if (arc < 9249)
			messages.push({
				role: "toolResult",
				toolCallId: `call-${arc}`,
				content: [{ type: "text", text: "result" }],
			});
	}
	if (countReads) {
		// Both route inference and user-boundary discovery inspect info. Count
		// those visits instead of enforcing a machine-dependent timing limit.
		for (const message of messages)
			Object.defineProperty(message, "info", {
				get() {
					reads++;
					return undefined;
				},
			});
	}
	return { messages, tags, gone, watermark, reads: () => reads };
}

test("Pi cutoff discovery is linear and independent of the cleared-set size", () => {
	for (const anthropic of [false, true]) {
		const work: number[] = [];
		for (const padding of [0, 21000]) {
			const f = fixture(true);
			for (let i = 0; i < padding; i++) f.gone.add(`other-branch-${i}`);
			let lookups = 0;
			piReasoningClearCutoff({
				messages: f.messages,
				messageIdToMaxTag: f.tags,
				piMessageStableId,
				keepReasoningTokens: 1000,
				prefixBound: false,
				anthropic,
				alreadyGone: (id) => {
					lookups++;
					return f.gone.has(id);
				},
			});
			expect(f.reads()).toBeLessThan(f.messages.length * 8);
			expect(lookups).toBeLessThan(f.messages.length * 2);
			work.push(f.reads() + lookups);
		}
		expect(work[1]).toBe(work[0]);
	}
});

test("large Pi reasoning cleanup clears 113 steps and replays identical bytes", () => {
	const temp = createTestTempDir("pi-reasoning-replay-");
	const db = openDatabase(join(temp.dir, "context.db"));
	try {
		const f = fixture();
		const sessionId = "large-reasoning-fixture";
		getOrCreateSessionMeta(db, sessionId);
		updateSessionMeta(db, sessionId, {
			clearedReasoningThroughTag: f.watermark,
		});
		addNativeReasoningIds(db, sessionId, f.gone);
		const times: Record<string, number> = {};
		const measure = <T>(name: string, fn: () => T): T => {
			const start = performance.now();
			const result = fn();
			times[name] = performance.now() - start;
			return result;
		};
		expect(
			measure("replay", () =>
				replayClearedReasoningPi({
					db,
					sessionId,
					messages: f.messages,
					messageIdToMaxTag: f.tags,
					piMessageStableId,
				}),
			),
		).toBe(7000);
		withSqliteTransformPass(() => {
			const start = performance.now();
			const nativeGone = measure(
				"nativeReplayRead",
				() => getNativeReplayState(db, sessionId).reasoningIds,
			);
			const calibration = measure("calibrationRead", () =>
				sessionDecisionCalibration(db, sessionId),
			);
			const maxCutoff = measure("cutoff", () =>
				piReasoningClearCutoff({
					messages: f.messages,
					messageIdToMaxTag: f.tags,
					piMessageStableId,
					keepReasoningTokens: 1000,
					prefixBound: false,
					anthropic: false,
					proseRatio: calibration.proseRatio,
					alreadyGone: (id) => nativeGone.has(id),
				}),
			);
			const args = {
				messages: f.messages,
				messageIdToMaxTag: f.tags,
				piMessageStableId,
				maxCutoff,
			};
			const clear = measure("clear", () => clearOldReasoningPi(args));
			const inline = measure("inline", () => stripInlineThinkingPi(args));
			expect(clear.cleared).toBe(113);
			expect(clear.newWatermark).toBe(58245);
			expect(inline.stripped).toBe(0);
			measure("persist", () =>
				updateSessionMeta(db, sessionId, {
					clearedReasoningThroughTag: clear.newWatermark,
				}),
			);
			times.stage = performance.now() - start;
		});
		const rebuilt = fixture();
		replayClearedReasoningPi({
			db,
			sessionId,
			messages: rebuilt.messages,
			messageIdToMaxTag: rebuilt.tags,
			piMessageStableId,
		});
		expect(JSON.stringify(rebuilt.messages)).toBe(JSON.stringify(f.messages));
		if (process.env.PI_REASONING_PROFILE === "1")
			console.info("Pi reasoning substeps (ms):", JSON.stringify(times));
	} finally {
		db.close();
		temp.cleanup();
	}
});

test("Pi watermark persistence under a second writer uses the bounded pass timeout", () => {
	const temp = createTestTempDir("pi-reasoning-replay-");
	const path = join(temp.dir, "context.db");
	const db = openDatabase(path);
	const blocker = new Database(path);
	try {
		getOrCreateSessionMeta(db, "locked-fixture");
		db.exec("PRAGMA busy_timeout=5000");
		blocker.exec("BEGIN IMMEDIATE");
		const start = performance.now();
		expect(() =>
			withSqliteTransformPass(() =>
				updateSessionMeta(db, "locked-fixture", {
					clearedReasoningThroughTag: 58245,
				}),
			),
		).toThrow("busy");
		const elapsed = performance.now() - start;
		expect(elapsed).toBeGreaterThanOrEqual(1900);
		expect(elapsed).toBeLessThan(2600);
		expect(db.prepare("PRAGMA busy_timeout").get()).toEqual({ timeout: 5000 });
		expect(
			getOrCreateSessionMeta(db, "locked-fixture").clearedReasoningThroughTag,
		).toBe(0);
		if (process.env.PI_REASONING_PROFILE === "1")
			console.info("Pi watermark blocked writer (ms):", elapsed);
	} finally {
		blocker.exec("ROLLBACK");
		blocker.close();
		db.close();
		temp.cleanup();
	}
});
