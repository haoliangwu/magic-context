import { describe, expect, it, spyOn } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { computeProtectionWindow } from "@magic-context/core/features/magic-context/protection-window";
import {
	getChannel2NudgeState,
	setChannel2NudgeState,
} from "@magic-context/core/features/magic-context/storage";
import type { TagEntry } from "@magic-context/core/features/magic-context/types";
import {
	rearmChannel2AfterCoverageAdvancingHardFold,
	rearmChannel2AfterMeasuredCollapse,
} from "@magic-context/core/hooks/magic-context/channel2-cycle";
import {
	decideChannel1,
	evaluateChannel2,
} from "@magic-context/core/hooks/magic-context/ctx-reduce-nudge";
import * as formattingModule from "@magic-context/core/hooks/magic-context/read-session-formatting";
import { PI_CTX_REDUCE_KEEP } from "./heuristic-cleanup-pi";
import {
	assertPiTailHygieneContentUnchanged,
	effectivePiTailHygiene,
	measurePiTailHygiene,
	refreshPiTailHygieneBaseline,
} from "./tail-hygiene-walk-pi";
import { createTestDb } from "./test-utils.test";

function tag(
	tagNumber: number,
	messageId: string,
	type: TagEntry["type"],
	overrides: Partial<TagEntry> = {},
): TagEntry {
	return {
		tagNumber,
		messageId,
		type,
		status: "active",
		dropMode: "full",
		toolName: type === "tool" ? "read" : null,
		inputByteSize: 0,
		byteSize: 1,
		reasoningByteSize: 0,
		sessionId: "pi-hygiene",
		cavemanDepth: 0,
		toolOwnerMessageId: type === "tool" ? "owner" : null,
		...overrides,
	};
}

function withStableIds(messages: object[], ids: string[]) {
	const byRef = new Map<object, string>();
	messages.forEach((message, index) => {
		byRef.set(message, ids[index] ?? `m-${index}`);
	});
	return (message: unknown): string | undefined =>
		message && typeof message === "object" ? byRef.get(message) : undefined;
}

function textMessage(
	role: "user" | "assistant",
	text: string,
): Record<string, unknown> {
	return { role, content: [{ type: "text", text }] };
}

function toolArc(
	ownerId: string,
	callId: string,
	toolName: string,
	input: unknown,
	output: string,
): {
	messages: object[];
	stableId: (message: unknown) => string | undefined;
	tag: TagEntry;
} {
	const messages = [
		{
			role: "assistant",
			content: [
				{ type: "toolCall", id: callId, name: toolName, arguments: input },
			],
		},
		{
			role: "toolResult",
			toolCallId: callId,
			toolName,
			content: [{ type: "text", text: output }],
		},
	];
	return {
		messages,
		stableId: withStableIds(messages, [ownerId, `${ownerId}-result`]),
		tag: tag(1, callId, "tool", { toolName, toolOwnerMessageId: ownerId }),
	};
}

function measuredBand(u: number, t: number): string {
	const baseline = {
		baselineU: u,
		baselineT: t,
		turnDeltaU: 0,
		turnDeltaT: 0,
		evaluable: true,
		generationInvalidated: false,
	};
	if (evaluateChannel2(baseline).shouldTrigger) return "channel2";
	const channel1 = decideChannel1({
		...baseline,
		lastNudgeUndropped: 0,
		lastNudgeLevel: "",
		hasRecentReduce: false,
	});
	return channel1.fire ? channel1.level : "quiet";
}

describe("Pi rendered-tail hygiene walk", () => {
	it("excludes thinking, redacted reasoning, and every signature field", () => {
		const base = [textMessage("assistant", "visible work ".repeat(2_000))];
		const withReasoning = [
			{
				role: "assistant",
				content: [
					{
						type: "text",
						text: "visible work ".repeat(2_000),
						textSignature: "signed text ".repeat(20_000),
					},
					{
						type: "thinking",
						thinking: "private chain ".repeat(50_000),
						thinkingSignature: "signed thought ".repeat(20_000),
					},
					{ type: "redacted_thinking", data: "opaque".repeat(50_000) },
				],
			},
		];
		const tags = [tag(1, "answer:p0", "message")];
		const expected = measurePiTailHygiene({
			messages: base,
			tags,
			protectedTagNumbers: new Set(),
			stableId: withStableIds(base, ["answer"]),
		});
		const actual = measurePiTailHygiene({
			messages: withReasoning,
			tags,
			protectedTagNumbers: new Set(),
			stableId: withStableIds(withReasoning, ["answer"]),
		});
		expect({ u: actual.u, t: actual.t }).toEqual({
			u: expected.u,
			t: expected.t,
		});
	});

	it("counts surviving dropped arcs in T without advertising their bytes in U", () => {
		const live = toolArc(
			"owner",
			"call",
			"read",
			{ path: "large" },
			"result ".repeat(5_000),
		);
		const dropped = toolArc(
			"owner",
			"call",
			"read",
			{ path: "large" },
			"[dropped §1§]",
		);
		const staleDroppedRow = { ...dropped.tag, status: "dropped" as const };
		const liveWithStaleStatus = measurePiTailHygiene({
			messages: live.messages,
			tags: [staleDroppedRow],
			protectedTagNumbers: new Set(),
			stableId: live.stableId,
		});
		const droppedMeasured = measurePiTailHygiene({
			messages: dropped.messages,
			tags: [dropped.tag],
			protectedTagNumbers: new Set(),
			stableId: dropped.stableId,
		});
		expect(liveWithStaleStatus.u).toBe(0);
		expect(liveWithStaleStatus.t).toBeGreaterThan(0);
		expect(droppedMeasured.u).toBe(0);
		expect(droppedMeasured.t).toBeGreaterThan(0);
	});

	it("keeps the recency reserve and newest three ctx_reduce exemplars out of U", () => {
		const messages: object[] = [];
		const ids: string[] = [];
		const tags: TagEntry[] = [];
		for (let index = 1; index <= 4; index += 1) {
			const arc = toolArc(
				`reduce-owner-${index}`,
				`reduce-${index}`,
				"ctx_reduce",
				{ drop: index },
				`reduced ${index}`,
			);
			messages.push(...arc.messages);
			ids.push(`reduce-owner-${index}`, `reduce-result-${index}`);
			tags.push({ ...arc.tag, tagNumber: index });
		}
		const measured = measurePiTailHygiene({
			messages,
			tags,
			protectedTagNumbers: new Set([4]),
			stableId: withStableIds(messages, ids),
		});
		const protectedNumbers = new Set(
			measured.parts
				.filter((part) => part.protected)
				.map((part) => part.tagNumber),
		);
		expect(PI_CTX_REDUCE_KEEP).toBe(3);
		expect(protectedNumbers).toEqual(new Set([2, 3, 4]));
		expect(
			measured.parts
				.filter((part) => part.tagNumber === 1)
				.every((part) => part.uTokens > 0),
		).toBe(true);
		expect(
			measured.parts
				.filter((part) => (part.tagNumber ?? 0) >= 2)
				.every((part) => part.uTokens === 0),
		).toBe(true);
	});

	it("handles empty, all-synthetic, untagged, and all-protected degenerates", () => {
		expect(
			measurePiTailHygiene({
				messages: [],
				tags: [],
				protectedTagNumbers: new Set(),
			}),
		).toMatchObject({
			u: 0,
			t: 0,
		});
		const synthetic = [textMessage("user", "m0 ".repeat(50_000))];
		expect(
			measurePiTailHygiene({
				messages: synthetic,
				tags: [tag(1, "m0:p0", "message")],
				protectedTagNumbers: new Set(),
				stableId: withStableIds(synthetic, ["m0"]),
				syntheticLeadingCount: 1,
			}),
		).toMatchObject({ u: 0, t: 0 });
		const untagged = [textMessage("user", "visible")];
		expect(
			measurePiTailHygiene({
				messages: untagged,
				tags: [],
				protectedTagNumbers: new Set(),
				stableId: withStableIds(untagged, ["untagged"]),
			}),
		).toMatchObject({ u: 0 });
		const protectedMessage = [textMessage("user", "protected ".repeat(1_000))];
		const protectedMeasured = measurePiTailHygiene({
			messages: protectedMessage,
			tags: [tag(1, "protected:p0", "message")],
			protectedTagNumbers: new Set([1]),
			stableId: withStableIds(protectedMessage, ["protected"]),
		});
		expect(protectedMeasured.u).toBe(0);
		expect(protectedMeasured.t).toBeGreaterThan(0);
		expect(protectedMeasured.u).toBeLessThanOrEqual(protectedMeasured.t);
	});

	it("enforces MIN_T on measurements from Pi entries", () => {
		const underMessages = [textMessage("user", "token ".repeat(59_000))];
		const overMessages = [textMessage("user", "token ".repeat(61_000))];
		const tags = [tag(1, "tail:p0", "message")];
		const under = measurePiTailHygiene({
			messages: underMessages,
			tags,
			protectedTagNumbers: new Set(),
			stableId: withStableIds(underMessages, ["tail"]),
		});
		const over = measurePiTailHygiene({
			messages: overMessages,
			tags,
			protectedTagNumbers: new Set(),
			stableId: withStableIds(overMessages, ["tail"]),
		});
		expect(under.t).toBeLessThan(60_000);
		expect(over.t).toBeGreaterThan(60_000);
		expect(
			decideChannel1({
				baselineU: under.u,
				baselineT: under.t,
				turnDeltaU: 0,
				turnDeltaT: 0,
				lastNudgeUndropped: 0,
				lastNudgeLevel: "",
				hasRecentReduce: false,
			}).fire,
		).toBe(false);
		expect(
			decideChannel1({
				baselineU: over.u,
				baselineT: over.t,
				turnDeltaU: 0,
				turnDeltaT: 0,
				lastNudgeUndropped: 0,
				lastNudgeLevel: "",
				hasRecentReduce: false,
			}).fire,
		).toBe(true);
	});
});

describe("Pi baseline persistence and defer deltas", () => {
	it("subtracts queued-drop mass through the defer delta without changing T or the frozen baseline", () => {
		const messages = [
			textMessage("user", "mass ".repeat(25_000)),
			textMessage("user", "mass ".repeat(45_000)),
			textMessage("user", "mass ".repeat(30_000)),
		];
		const tags = [
			tag(1, "queued:p0", "message"),
			tag(2, "remaining:p0", "message"),
		];
		const stableId = withStableIds(messages, [
			"queued",
			"remaining",
			"untagged",
		]);
		const initial = measurePiTailHygiene({
			messages,
			tags,
			protectedTagNumbers: new Set(),
			stableId,
		});
		const queuedMass = measurePiTailHygiene({
			messages: [messages[0]],
			tags: [tags[0]],
			protectedTagNumbers: new Set(),
			stableId: withStableIds([messages[0]], ["queued"]),
		}).u;
		const baseline = refreshPiTailHygieneBaseline({
			messages,
			tags,
			protectedTagNumbers: new Set(),
			stableId,
			cacheBusting: true,
		});
		const queued = measurePiTailHygiene({
			messages,
			tags,
			protectedTagNumbers: new Set(),
			pendingDropTagNumbers: new Set([1]),
			stableId,
		});
		const defer = refreshPiTailHygieneBaseline({
			messages,
			tags,
			protectedTagNumbers: new Set(),
			pendingDropTagNumbers: new Set([1]),
			stableId,
			cacheBusting: false,
			previous: baseline,
		});

		expect(queued.t).toBe(initial.t);
		expect(queued.u).toBe(initial.u - queuedMass);
		expect(defer.evaluable).toBe(true);
		expect(defer.baselineU).toBe(baseline.baselineU);
		expect(defer.baselineT).toBe(baseline.baselineT);
		expect(effectivePiTailHygiene(defer)).toEqual({ u: queued.u, t: queued.t });
		expect(
			decideChannel1({
				...baseline,
				lastNudgeUndropped: 0,
				lastNudgeLevel: "",
				hasRecentReduce: false,
			}).level,
		).toBe("urgent");
		expect(
			decideChannel1({
				...defer,
				lastNudgeUndropped: 0,
				lastNudgeLevel: "",
				hasRecentReduce: false,
			}).level,
		).toBe("firm");
	});

	it("is deterministic across bust/defer and adds every typed append", () => {
		const base = [textMessage("user", "base ".repeat(2_000))];
		const baseTags = [tag(1, "base:p0", "message")];
		const bust = refreshPiTailHygieneBaseline({
			messages: base,
			tags: baseTags,
			protectedTagNumbers: new Set([1]),
			stableId: withStableIds(base, ["base"]),
			cacheBusting: true,
			now: 10,
		});
		const unchanged = refreshPiTailHygieneBaseline({
			messages: base,
			tags: baseTags,
			protectedTagNumbers: new Set([1]),
			stableId: withStableIds(base, ["base"]),
			cacheBusting: false,
			previous: bust,
			now: 20,
		});
		expect(effectivePiTailHygiene(unchanged)).toEqual(
			effectivePiTailHygiene(bust),
		);
		expect(unchanged.baselineGeneration).toBe(bust.baselineGeneration);

		const user = textMessage("user", "new user ".repeat(1_000));
		const assistant = textMessage("assistant", "new assistant ".repeat(1_000));
		const image = {
			role: "user",
			content: [
				{
					type: "image",
					data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB",
					mimeType: "image/png",
				},
			],
		};
		const tool = toolArc(
			"tool-owner",
			"call-delta",
			"read",
			{ path: "new" },
			"output ".repeat(1_000),
		);
		const messages = [...base, user, assistant, image, ...tool.messages];
		const tags = [
			...baseTags,
			tag(2, "user:p0", "message"),
			tag(3, "assistant:p0", "message"),
			tag(4, "image:file0", "file"),
			{ ...tool.tag, tagNumber: 5 },
		];
		const defer = refreshPiTailHygieneBaseline({
			messages,
			tags,
			protectedTagNumbers: new Set([5]),
			stableId: withStableIds(messages, [
				"base",
				"user",
				"assistant",
				"image",
				"tool-owner",
				"tool-result",
			]),
			cacheBusting: false,
			previous: bust,
		});
		expect(defer.evaluable).toBe(true);
		expect(defer.turnDeltaT).toBeGreaterThan(0);
		expect(defer.turnDeltaU).toBeGreaterThan(0);
		expect(effectivePiTailHygiene(defer).u).toBeLessThanOrEqual(
			effectivePiTailHygiene(defer).t,
		);
	});

	it("advances the protection boundary additively without changing generation", () => {
		const before = [
			textMessage("user", "old mass ".repeat(2_000)),
			textMessage("assistant", "recent mass ".repeat(2_000)),
		];
		const beforeTags = [
			tag(1, "old:p0", "message"),
			tag(2, "recent:p0", "message"),
		];
		const baseline = refreshPiTailHygieneBaseline({
			messages: before,
			tags: beforeTags,
			protectedTagNumbers: new Set([1, 2]),
			stableId: withStableIds(before, ["old", "recent"]),
			cacheBusting: true,
		});
		const oldMass = measurePiTailHygiene({
			messages: [before[0]],
			tags: [beforeTags[0]],
			protectedTagNumbers: new Set(),
			stableId: withStableIds([before[0]], ["old"]),
		}).t;
		const newest = textMessage("user", "newest mass ".repeat(2_000));
		const messages = [...before, newest];
		const defer = refreshPiTailHygieneBaseline({
			messages,
			tags: [...beforeTags, tag(3, "newest:p0", "message")],
			protectedTagNumbers: new Set([2, 3]),
			stableId: withStableIds(messages, ["old", "recent", "newest"]),
			cacheBusting: false,
			previous: baseline,
		});
		expect(baseline.baselineU).toBe(0);
		expect(defer.turnDeltaU).toBe(oldMass);
		expect(defer.evaluable).toBe(true);
		expect(defer.baselineGeneration).toBe(baseline.baselineGeneration);
	});

	it("marks prior-part mutation NOT EVALUABLE until a bust rewalk", () => {
		const original = [textMessage("user", "original")];
		const changed = [textMessage("user", "changed")];
		const tags = [tag(1, "m:p0", "message")];
		const baseline = refreshPiTailHygieneBaseline({
			messages: original,
			tags,
			protectedTagNumbers: new Set(),
			stableId: withStableIds(original, ["m"]),
			cacheBusting: true,
		});
		const invalidated = refreshPiTailHygieneBaseline({
			messages: changed,
			tags,
			protectedTagNumbers: new Set(),
			stableId: withStableIds(changed, ["m"]),
			cacheBusting: false,
			previous: baseline,
		});
		expect(invalidated.evaluable).toBe(false);
		expect(invalidated.generationInvalidated).toBe(true);
		expect(evaluateChannel2(invalidated).evaluable).toBe(false);
		const refreshed = refreshPiTailHygieneBaseline({
			messages: changed,
			tags,
			protectedTagNumbers: new Set(),
			stableId: withStableIds(changed, ["m"]),
			cacheBusting: true,
			previous: invalidated,
		});
		expect(refreshed.evaluable).toBe(true);
		expect(refreshed.baselineGeneration).toBe(baseline.baselineGeneration + 1);
	});

	it("detects a byte mutation after the final walk", () => {
		const messages = [textMessage("user", "stable")];
		const stableId = withStableIds(messages, ["m"]);
		const tags = [tag(1, "m:p0", "message")];
		const measured = measurePiTailHygiene({
			messages,
			tags,
			protectedTagNumbers: new Set(),
			stableId,
		});
		(
			(messages[0] as { content: Array<{ text: string }> }).content[0] as {
				text: string;
			}
		).text = "mutated";
		expect(() =>
			assertPiTailHygieneContentUnchanged({
				messages,
				tags,
				protectedTagNumbers: new Set(),
				stableId,
				expectedSignature: measured.contentSignature,
			}),
		).toThrow(/not the last byte-affecting operation/i);
	});
});

describe("Pi Channel-2 tail-cycle cap", () => {
	it("re-arms only for a coverage-advancing HARD fold", () => {
		const db = createTestDb();
		const session = "pi-cap-fold";
		const scenarios = [
			{
				foldExecuted: false,
				compactionOff: false,
				previousCoverage: 1,
				currentCoverage: 2,
			},
			{
				foldExecuted: true,
				compactionOff: true,
				previousCoverage: 1,
				currentCoverage: 2,
			},
			{
				foldExecuted: true,
				compactionOff: false,
				previousCoverage: 2,
				currentCoverage: 2,
			},
		];
		for (const scenario of scenarios) {
			setChannel2NudgeState(db, session, "delivered");
			expect(
				rearmChannel2AfterCoverageAdvancingHardFold({
					db,
					sessionId: session,
					...scenario,
				}),
			).toBe(false);
			expect(getChannel2NudgeState(db, session)).toBe("delivered");
		}
		setChannel2NudgeState(db, session, "delivered");
		expect(
			rearmChannel2AfterCoverageAdvancingHardFold({
				db,
				sessionId: session,
				foldExecuted: true,
				compactionOff: false,
				previousCoverage: 1,
				currentCoverage: 2,
			}),
		).toBe(true);
		expect(getChannel2NudgeState(db, session)).toBe("");
	});

	it("re-arms on measured U collapse but not an invalidated or still-large baseline", () => {
		const db = createTestDb();
		const session = "pi-cap-collapse";
		const baseline = (u: number, evaluable = true) => ({
			baselineU: u,
			baselineT: 100_000,
			turnDeltaU: 0,
			turnDeltaT: 0,
			evaluable,
			generationInvalidated: !evaluable,
		});
		for (const held of [baseline(25_000), baseline(10_000, false)]) {
			setChannel2NudgeState(db, session, "delivered");
			expect(
				rearmChannel2AfterMeasuredCollapse({
					db,
					sessionId: session,
					baseline: held,
				}),
			).toBe(false);
			expect(getChannel2NudgeState(db, session)).toBe("delivered");
		}
		setChannel2NudgeState(db, session, "delivered");
		expect(
			rearmChannel2AfterMeasuredCollapse({
				db,
				sessionId: session,
				baseline: baseline(24_999),
			}),
		).toBe(true);
		expect(getChannel2NudgeState(db, session)).toBe("");
	});
});

type FixtureBlock =
	| { type: "text"; unit: string; repeat: number }
	| { type: "reasoning"; unit: string; repeat: number }
	| { type: "tool_call"; id: string; name: string; input: unknown }
	| {
			type: "tool_result";
			id: string;
			name: string;
			unit: string;
			repeat: number;
	  }
	| { type: "file"; mime: string; url: string };
type FixtureMessage = {
	mid: string;
	ordinal: number;
	role: "user" | "assistant";
	synthetic?: boolean;
	blocks: FixtureBlock[];
};
type FixtureTag = {
	tag_number: number;
	block_id: string;
	kind: "message" | "tool" | "file";
	token_count: number;
};
type HygieneFixture = {
	id: string;
	/** Retained as inert migration input; protection derives from the token fields below. */
	protected_tags: number;
	protected_tokens_effective: number;
	messages: FixtureMessage[];
	tags: FixtureTag[];
	pending_drop_tag_numbers?: number[];
	expected: { u: number; t: number; band: string };
};

function adaptFixtureToPi(fixture: HygieneFixture): {
	messages: object[];
	tags: TagEntry[];
	stableId: (message: unknown) => string | undefined;
	syntheticMessages: ReadonlySet<object>;
} {
	const messages: object[] = [];
	const ids: string[] = [];
	const syntheticMessages = new Set<object>();
	for (const message of fixture.messages) {
		for (const block of message.blocks) {
			let adapted: object;
			if (block.type === "tool_result") {
				adapted = {
					role: "toolResult",
					toolCallId: block.id,
					toolName: block.name,
					content: [{ type: "text", text: block.unit.repeat(block.repeat) }],
				};
			} else if (block.type === "reasoning") {
				adapted = {
					role: "assistant",
					content: [
						{
							type: "thinking",
							thinking: block.unit.repeat(block.repeat),
							thinkingSignature: "fixture-signature",
						},
					],
				};
			} else if (block.type === "tool_call") {
				adapted = {
					role: "assistant",
					content: [
						{
							type: "toolCall",
							id: block.id,
							name: block.name,
							arguments: block.input,
						},
					],
				};
			} else if (block.type === "file" && block.mime.startsWith("image/")) {
				adapted = {
					role: message.role,
					content: [{ type: "image", data: block.url, mimeType: block.mime }],
				};
			} else {
				const text =
					block.type === "text" ? block.unit.repeat(block.repeat) : block.url;
				adapted = { role: message.role, content: [{ type: "text", text }] };
			}
			messages.push(adapted);
			ids.push(message.mid);
			if (message.synthetic === true) syntheticMessages.add(adapted);
		}
	}
	const ownerByCall = new Map<string, string>();
	for (const message of fixture.messages) {
		for (const block of message.blocks) {
			if (block.type === "tool_call" && !ownerByCall.has(block.id)) {
				ownerByCall.set(block.id, message.mid);
			}
		}
	}
	const messagesByMid = new Map(
		fixture.messages.map((message) => [message.mid, message]),
	);
	const tags = fixture.tags.map((fixtureTag) => {
		const [mid, rawIndex] = fixtureTag.block_id.split("#");
		const partIndex = Number(rawIndex);
		const block = messagesByMid.get(mid ?? "")?.blocks[partIndex];
		const legacyCallId =
			!block && fixtureTag.kind === "tool" ? fixtureTag.block_id : null;
		const callId =
			block?.type === "tool_call" || block?.type === "tool_result"
				? block.id
				: legacyCallId;
		const isTextFile =
			block?.type === "file" && !block.mime.startsWith("image/");
		const messageId =
			fixtureTag.kind === "tool"
				? (callId ?? fixtureTag.block_id)
				: isTextFile
					? `${mid}:p0`
					: `${mid}:${fixtureTag.kind === "file" ? "file" : "p"}${partIndex}`;
		return tag(fixtureTag.tag_number, messageId, fixtureTag.kind, {
			toolName:
				fixtureTag.kind === "tool" &&
				(block?.type === "tool_call" || block?.type === "tool_result")
					? block.name
					: fixtureTag.kind === "tool"
						? "read"
						: null,
			toolOwnerMessageId:
				fixtureTag.kind === "tool" && !legacyCallId && callId
					? (ownerByCall.get(callId) ?? null)
					: null,
		});
	});
	return {
		messages,
		tags,
		stableId: withStableIds(messages, ids),
		syntheticMessages,
	};
}

describe("TS/Pi/module differential hygiene corpus", () => {
	const golden = JSON.parse(
		readFileSync(
			join(
				import.meta.dir,
				"../../../crates/mc-module/testdata/nudge-hygiene-golden.json",
			),
			"utf8",
		),
	) as {
		schema: number;
		provenance: { generator_version: string };
		cases: HygieneFixture[];
	};

	it("keeps Pi as the third leg across the full shared corpus", () => {
		expect(golden.schema).toBe(2);
		expect(golden.provenance.generator_version).toBe("nudge-hygiene-ts-v3");
		expect(golden.cases.length).toBeGreaterThanOrEqual(14);
		for (const fixture of golden.cases) {
			const adapted = adaptFixtureToPi(fixture);
			const protectedTagNumbers = computeProtectionWindow(
				fixture.tags,
				fixture.protected_tokens_effective,
			).tagNumberSet.tagNumbers;
			const measured = measurePiTailHygiene({
				...adapted,
				protectedTagNumbers,
				pendingDropTagNumbers: new Set(fixture.pending_drop_tag_numbers ?? []),
			});
			for (const [label, actual, expected] of [
				["U", measured.u, fixture.expected.u],
				["T", measured.t, fixture.expected.t],
			] as const) {
				const tolerance = Math.max(12, Math.ceil(Math.abs(expected) * 0.03));
				expect(
					Math.abs(actual - expected),
					`${fixture.id} ${label}`,
				).toBeLessThanOrEqual(tolerance);
			}
			expect(measuredBand(measured.u, measured.t), `${fixture.id} band`).toBe(
				fixture.expected.band,
			);
			expect(measured.u).toBeLessThanOrEqual(measured.t);
		}
	});
});

describe("Pi image content memoization", () => {
	it("hashes raw and prefixed user/tool images without text-tokenizing their payloads", () => {
		const rawPayload = "A".repeat(3 * 1024 * 1024);
		const prefixedPayload = `data:image/png;base64,${rawPayload}`;
		const messages = [
			{
				role: "user",
				content: [{ type: "image", data: rawPayload, mimeType: "image/png" }],
			},
			{
				role: "assistant",
				content: [
					{
						type: "toolCall",
						id: "image-call",
						name: "read",
						arguments: { path: "image-fixture" },
					},
				],
			},
			{
				role: "toolResult",
				toolCallId: "image-call",
				toolName: "read",
				content: [
					{ type: "image", data: prefixedPayload, mimeType: "image/png" },
				],
			},
		];
		const tokenizer = spyOn(formattingModule, "estimateTokens");
		try {
			const stableId = withStableIds(messages, [
				"user-image",
				"tool-owner",
				"tool-result",
			]);
			const tags = [
				tag(1, "user-image:file0", "file"),
				tag(2, "image-call", "tool", { toolOwnerMessageId: "tool-owner" }),
			];
			const baseline = measurePiTailHygiene({
				messages,
				tags,
				protectedTagNumbers: new Set(),
				stableId,
			});
			const measured = measurePiTailHygiene({
				messages,
				tags,
				protectedTagNumbers: new Set([2]),
				pendingDropTagNumbers: new Set([1]),
				stableId,
			});
			const imageParts = measured.parts.filter(
				(part) => part.kind === "file" || part.kind === "toolOutput",
			);
			const imagePayloadCalls = tokenizer.mock.calls.filter(
				([content]) =>
					typeof content === "string" && content.includes(rawPayload),
			);

			expect(imagePayloadCalls).toHaveLength(0);
			expect(imageParts.map(({ kind, tokens }) => ({ kind, tokens }))).toEqual([
				{ kind: "file", tokens: 1200 },
				{ kind: "toolOutput", tokens: 1200 },
			]);
			expect(measured.t).toBe(baseline.t);
			expect(measured.u).toBe(0);
			expect(baseline.contentSignature).toBe(measured.contentSignature);
			expect(measured.contentSignature).toBe("721a4413");
			expect(measured.parts.find((part) => part.tagNumber === 1)).toMatchObject(
				{
					queuedForDrop: true,
					protected: false,
				},
			);
			expect(
				measured.parts
					.filter((part) => part.tagNumber === 2)
					.every((part) => part.protected && part.uTokens === 0),
			).toBe(true);
		} finally {
			tokenizer.mockRestore();
		}
	});

	it("counts a tool-output key once when an image hash is requested first", () => {
		const content = `data:image/png;base64,${"B".repeat(64)}`;
		const messages = [
			{
				role: "assistant",
				content: [
					{
						type: "toolCall",
						id: "hash-first-call",
						name: "read",
						arguments: { path: "hash-first" },
					},
				],
			},
			{
				role: "toolResult",
				toolCallId: "hash-first-call",
				toolName: "read",
				content: [
					{ type: "image", data: content, mimeType: "image/png" },
					{ type: "text", text: content },
				],
			},
		];
		const expectedTextTokens = formattingModule.estimateTokens(content);
		const tokenizer = spyOn(formattingModule, "estimateTokens");
		try {
			const measured = measurePiTailHygiene({
				messages,
				tags: [
					tag(3, "hash-first-call", "tool", {
						toolOwnerMessageId: "hash-first-owner",
					}),
				],
				protectedTagNumbers: new Set(),
				stableId: withStableIds(messages, [
					"hash-first-owner",
					"hash-first-result",
				]),
			});
			const textCalls = tokenizer.mock.calls.filter(
				([value]) => value === content,
			);
			const toolOutputParts = measured.parts.filter(
				(part) => part.kind === "toolOutput",
			);

			expect(textCalls).toHaveLength(1);
			expect(toolOutputParts.map((part) => part.tokens)).toEqual([
				1200,
				expectedTextTokens,
			]);
		} finally {
			tokenizer.mockRestore();
		}
	});

	it("caches a genuine zero and keeps excluded content out of the tokenizer", () => {
		const zeroContent = "pi-zero-token-fixture";
		const excludedContent = "pi-excluded-fixture";
		const tokenizer = spyOn(
			formattingModule,
			"estimateTokens",
		).mockImplementation((content) => (content === zeroContent ? 0 : 1));
		try {
			const messages = [
				{
					role: "user",
					content: [
						{ type: "text", text: zeroContent },
						{ type: "thinking", thinking: excludedContent },
					],
				},
			];
			const input = {
				messages,
				tags: [tag(4, "zero:p0", "message")],
				protectedTagNumbers: new Set<number>(),
				stableId: withStableIds(messages, ["zero"]),
			};
			const first = measurePiTailHygiene(input);
			const second = measurePiTailHygiene(input);
			expect(first.parts.find((part) => part.kind === "text")?.tokens).toBe(0);
			expect(second.parts.find((part) => part.kind === "text")?.tokens).toBe(0);
			expect(
				tokenizer.mock.calls.filter(([value]) => value === zeroContent),
			).toHaveLength(1);
			expect(
				tokenizer.mock.calls.filter(([value]) => value === excludedContent),
			).toHaveLength(0);
		} finally {
			tokenizer.mockRestore();
		}
	});
});

describe("Pi hygiene walk performance", () => {
	it("memoized 250k-token rendered tail walks are cheap relative to the cold walk", () => {
		const messages = [textMessage("user", "token ".repeat(250_000))];
		const tags = [tag(1, "perf:p0", "message")];
		const stableId = withStableIds(messages, ["perf"]);
		const walk = (content: string) => {
			(messages[0] as { content: string }).content = content;
			const start = performance.now();
			measurePiTailHygiene({
				messages,
				tags,
				protectedTagNumbers: new Set(),
				stableId,
			});
			return performance.now() - start;
		};
		const p95Of = (samples: number[]) => {
			const sorted = [...samples].sort((left, right) => left - right);
			return (
				sorted[Math.ceil(sorted.length * 0.95) - 1] ?? Number.POSITIVE_INFINITY
			);
		};
		// The content memo is keyed on the rendered text, so a walk over unchanged
		// content must skip tokenization while a walk over fresh content pays it.
		// A shared CI runner cannot promise an absolute millisecond budget (the
		// memoized walk read 2.7ms locally and 19ms on a loaded runner), so the
		// invariant is the ratio between the unmemoized and memoized walks measured
		// in the same process, which load scales equally. The absolute ceiling is
		// kept behind MC_PERF_GATE for machines that opt into wall-clock budgets.
		const base = "token ".repeat(250_000);
		const unmemoized: number[] = [];
		for (let iteration = 0; iteration < 8; iteration += 1) {
			unmemoized.push(walk(`${base} fresh-${iteration}`));
		}
		walk(base);
		const memoized: number[] = [];
		for (let iteration = 0; iteration < 25; iteration += 1)
			memoized.push(walk(base));
		const unmemoizedP95 = p95Of(unmemoized);
		const p95 = p95Of(memoized);
		console.log(
			`pi-tail-hygiene-walk 250k-token unmemoized p95=${unmemoizedP95.toFixed(3)}ms memoized p95=${p95.toFixed(3)}ms`,
		);
		expect(p95).toBeLessThan(unmemoizedP95 / 5);
		if (process.env.MC_PERF_GATE === "1") expect(p95).toBeLessThan(15);
	});
});
