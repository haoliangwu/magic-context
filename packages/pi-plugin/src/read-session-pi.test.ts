/// <reference types="bun-types" />

import { describe, expect, it } from "bun:test";
import { findFirstKeptEntryId } from "./pi-historian-runner";
import {
	convertEntriesToRawMessagePage,
	convertEntriesToRawMessages,
	findLastModelKeyFromBranch,
	findRestartModelSeedFromBranch,
} from "./read-session-pi";

describe("findRestartModelSeedFromBranch", () => {
	const reply = (provider: string, model: string) => ({
		type: "message",
		message: { role: "assistant", provider, model },
	});
	const change = (provider: string, modelId: string) => ({
		type: "model_change",
		provider,
		modelId,
	});

	it("uses the last reply's model when a model_change follows it", () => {
		expect(
			findRestartModelSeedFromBranch([
				change("google-antigravity", "gemini"),
				reply("google-antigravity", "gemini"),
				change("openai-codex", "gpt-6-sol"),
			]),
		).toBe("google-antigravity/gemini");
	});

	it("keeps the last model_change when no switch follows the last reply", () => {
		expect(
			findRestartModelSeedFromBranch([
				change("openai-codex", "gpt-6-sol"),
				reply("test-provider", "test-model"),
			]),
		).toBe("openai-codex/gpt-6-sol");
		expect(
			findRestartModelSeedFromBranch([change("openai-codex", "gpt-6-sol")]),
		).toBe("openai-codex/gpt-6-sol");
		expect(findRestartModelSeedFromBranch([reply("a", "b")])).toBeUndefined();
	});
});

describe("convertEntriesToRawMessages: synthetic-user entry-id propagation", () => {
	// Regression coverage for the cortexkit/magic-context X1+X2 production
	// bugs. Pi sessions with many `toolResult → assistant` transitions emit
	// synthetic user RawMessages. The original implementation set those
	// synthetic users' `id` to `""`, which broke two downstream consumers:
	//
	//   - read-session-chunk.ts:345 puts `messageId: msg.id` into
	//     `chunk.lines`. When the chunk's final ordinal lands on a synthetic
	//     user, `mapParsedCompartmentsToChunk` populates `endMessageId = ""`
	//     on the published compartment, breaking the magic-context
	//     boundary-trim path. (Bug X2)
	//   - pi-historian-runner.ts:findFirstKeptEntryId walks raw
	//     SessionEntries with its own counter that skips synthetics
	//     entirely, never reaching the historian's `lastCompactedOrdinal`.
	//     It returns null, `appendCompaction` is silently skipped, the
	//     JSONL grows unbounded, and Pi/Codex eventually rejects the wire
	//     payload with context_length_exceeded. (Bug X1)
	//
	// Fix: synthetic users now carry the FIRST folded toolResult's entry id
	// as `RawMessage.id`. That id is always a real, lookup-able SessionEntry
	// id, so chunk.lines and compaction-marker placement both work
	// correctly. findFirstKeptEntryId now delegates to
	// convertEntriesToRawMessages so the two ordinal counters can't diverge.

	function messageEntry(
		id: string,
		message: Record<string, unknown>,
	): Record<string, unknown> {
		return { type: "message", id, message };
	}

	it("parses Pi JSONL ISO entry timestamps into indexed epoch milliseconds", () => {
		const entries = [
			{
				...messageEntry("user-time", { role: "user", content: "timed" }),
				timestamp: "2026-09-22T12:34:56.789Z",
			},
		];

		expect(convertEntriesToRawMessages(entries)[0]?.createdAt).toBe(
			Date.parse("2026-09-22T12:34:56.789Z"),
		);
	});

	it("skips current custom entries and historical ctx-status custom messages", () => {
		const entries = [
			messageEntry("user-1", { role: "user", content: "before" }),
			{
				type: "custom",
				id: "status-current",
				customType: "ctx-status",
				data: { title: "Magic Embed", text: "Embedding history…" },
			},
			{
				type: "custom_message",
				id: "status-historical",
				customType: "ctx-status",
				content: "Historical status",
				display: true,
			},
			messageEntry("asst-1", { role: "assistant", content: "after" }),
		];

		expect(
			convertEntriesToRawMessages(entries).map(({ id, role }) => ({
				id,
				role,
			})),
		).toEqual([
			{ id: "user-1", role: "user" },
			{ id: "asst-1", role: "assistant" },
		]);
	});

	it("assigns the first folded toolResult's id to a synthetic user emitted at toolResult→assistant", () => {
		const entries = [
			messageEntry("user-1", { role: "user", content: "kick off" }),
			messageEntry("asst-1", {
				role: "assistant",
				content: [{ type: "toolCall", id: "tc-1", name: "read" }],
			}),
			messageEntry("tr-1", {
				role: "toolResult",
				toolCallId: "tc-1",
				toolName: "read",
				content: [{ type: "text", text: "output-1" }],
			}),
			// toolResult → assistant: synthetic user gets emitted here
			messageEntry("asst-2", {
				role: "assistant",
				content: [{ type: "text", text: "follow-up" }],
			}),
		];

		const raws = convertEntriesToRawMessages(entries);

		// Expected ordinal layout:
		//   1: user-1 (real)
		//   2: asst-1 (real)
		//   3: synthetic user folding tr-1 — MUST carry tr-1's id
		//   4: asst-2 (real)
		expect(
			raws.map((r) => ({ ordinal: r.ordinal, id: r.id, role: r.role })),
		).toEqual([
			{ ordinal: 1, id: "user-1", role: "user" },
			{ ordinal: 2, id: "asst-1", role: "assistant" },
			{ ordinal: 3, id: "synth-user-tr-1", role: "user" },
			{ ordinal: 4, id: "asst-2", role: "assistant" },
		]);
	});

	it("assigns the first folded toolResult's id when multiple toolResults stack before an assistant", () => {
		const entries = [
			messageEntry("user-1", { role: "user", content: "start" }),
			messageEntry("asst-1", {
				role: "assistant",
				content: [
					{ type: "toolCall", id: "tc-1", name: "read" },
					{ type: "toolCall", id: "tc-2", name: "read" },
				],
			}),
			messageEntry("tr-1", {
				role: "toolResult",
				toolCallId: "tc-1",
				toolName: "read",
				content: [{ type: "text", text: "out-1" }],
			}),
			messageEntry("tr-2", {
				role: "toolResult",
				toolCallId: "tc-2",
				toolName: "read",
				content: [{ type: "text", text: "out-2" }],
			}),
			// stacked tr-1, tr-2 fold into synthetic user at this transition
			messageEntry("asst-2", { role: "assistant", content: [] }),
		];

		const raws = convertEntriesToRawMessages(entries);
		const synthetic = raws[2];
		expect(synthetic?.ordinal).toBe(3);
		expect(synthetic?.role).toBe("user");
		// First folded toolResult wins — never empty.
		expect(synthetic?.id).toBe("synth-user-tr-1");
	});

	it("assigns the first folded toolResult's id to a trailing-tail synthetic user", () => {
		const entries = [
			messageEntry("user-1", { role: "user", content: "start" }),
			messageEntry("asst-1", {
				role: "assistant",
				content: [{ type: "toolCall", id: "tc-1", name: "read" }],
			}),
			messageEntry("tr-tail", {
				role: "toolResult",
				toolCallId: "tc-1",
				toolName: "read",
				content: [{ type: "text", text: "tail" }],
			}),
			// No following user/assistant — trailing tail synthetic emits
		];

		const raws = convertEntriesToRawMessages(entries);
		const tail = raws[raws.length - 1];
		expect(tail?.ordinal).toBe(3);
		expect(tail?.role).toBe("user");
		expect(tail?.id).toBe("synth-user-tr-tail");
	});

	it("clears pending state after a real user folds toolResults", () => {
		// Real user message folds toolResults — no synthetic should emit.
		// The pending state must reset so a LATER synthetic point doesn't
		// reuse a stale toolResult id.
		const entries = [
			messageEntry("asst-1", {
				role: "assistant",
				content: [{ type: "toolCall", id: "tc-1", name: "read" }],
			}),
			messageEntry("tr-1", {
				role: "toolResult",
				toolCallId: "tc-1",
				toolName: "read",
				content: [{ type: "text", text: "x" }],
			}),
			messageEntry("real-user", { role: "user", content: "next" }),
			messageEntry("asst-2", {
				role: "assistant",
				content: [{ type: "toolCall", id: "tc-2", name: "read" }],
			}),
			messageEntry("tr-2", {
				role: "toolResult",
				toolCallId: "tc-2",
				toolName: "read",
				content: [{ type: "text", text: "y" }],
			}),
			messageEntry("asst-3", { role: "assistant", content: [] }),
		];

		const raws = convertEntriesToRawMessages(entries);
		// Expected:
		//   1: asst-1
		//   2: real-user (folds tr-1)        — id="real-user", NOT "tr-1"
		//   3: asst-2
		//   4: synthetic user folding tr-2   — id="tr-2"
		//   5: asst-3
		expect(
			raws.map((r) => ({ ordinal: r.ordinal, id: r.id, role: r.role })),
		).toEqual([
			{ ordinal: 1, id: "asst-1", role: "assistant" },
			{ ordinal: 2, id: "real-user", role: "user" },
			{ ordinal: 3, id: "asst-2", role: "assistant" },
			{ ordinal: 4, id: "synth-user-tr-2", role: "user" },
			{ ordinal: 5, id: "asst-3", role: "assistant" },
		]);
	});

	it("reproduces the user-session ordinal divergence: every RawMessage has a non-empty id", () => {
		// Build a branch that mirrors the user's stuck session pattern:
		// alternating assistant → toolResult → assistant transitions
		// produce a flood of synthetic users. Each synthetic must carry
		// the folded toolResult's id; no RawMessage may have id="".
		//
		// Pattern: kickoff user, then 50 cycles of
		//   assistant(toolCall) → toolResult → assistant(toolCall) → toolResult → ...
		// terminated by a final assistant. This is structurally identical
		// to a tool-heavy autonomous run where the agent fires tools, sees
		// results, and immediately fires more without user input.
		const entries: Array<Record<string, unknown>> = [
			messageEntry("u-0", { role: "user", content: "go" }),
		];
		for (let i = 1; i <= 50; i++) {
			entries.push(
				messageEntry(`a-${i}`, {
					role: "assistant",
					content: [{ type: "toolCall", id: `tc-${i}`, name: "read" }],
				}),
				messageEntry(`tr-${i}`, {
					role: "toolResult",
					toolCallId: `tc-${i}`,
					toolName: "read",
					content: [{ type: "text", text: `out-${i}` }],
				}),
			);
		}
		entries.push(
			messageEntry("a-final", {
				role: "assistant",
				content: [{ type: "text", text: "done" }],
			}),
		);

		const raws = convertEntriesToRawMessages(entries);

		// Every RawMessage must carry a non-empty id, including synthetics.
		// Pre-fix this assertion failed because synthetic-user emissions
		// at every toolResult→assistant transition had id="".
		const empties = raws.filter((r) => !r.id || r.id.length === 0);
		expect(empties).toEqual([]);

		// Ordinals are contiguous from 1.
		const ordinals = raws.map((r) => r.ordinal);
		expect(ordinals[0]).toBe(1);
		for (let i = 1; i < ordinals.length; i++) {
			const prev = ordinals[i - 1] ?? 0;
			const cur = ordinals[i] ?? 0;
			expect(cur).toBe(prev + 1);
		}

		// 50 synthetic users (toolResult→assistant transitions) emitted,
		// each carrying its first folded toolResult's id.
		const syntheticUsers = raws.filter(
			(r, idx) =>
				r.role === "user" &&
				idx > 0 &&
				raws[idx - 1] !== undefined &&
				raws[idx - 1]?.role === "assistant" &&
				r.id.startsWith("synth-user-tr-"),
		);
		expect(syntheticUsers.length).toBe(50);
	});
});

describe("findFirstKeptEntryId — replay-safe boundary resolution", () => {
	function messageEntry(
		id: string,
		message: Record<string, unknown>,
	): Record<string, unknown> {
		return { type: "message", id, message };
	}

	// Branch: user(u-0) → assistant(toolCall) → toolResult → assistant(text).
	// RawMessage ordinals: 1=u-0, 2=asst-1, 3=synthetic-user(folds tr-1, id
	// `${PREFIX}tr-1`), 4=asst-2.
	const entries = [
		messageEntry("u-0", { role: "user", content: "go" }),
		messageEntry("asst-1", {
			role: "assistant",
			content: [{ type: "toolCall", id: "tc-1", name: "read" }],
		}),
		messageEntry("tr-1", {
			role: "toolResult",
			toolCallId: "tc-1",
			toolName: "read",
			content: [{ type: "text", text: "out" }],
		}),
		messageEntry("asst-2", {
			role: "assistant",
			content: [{ type: "text", text: "done" }],
		}),
	];

	it("returns a real entry id when the boundary lands on a normal message", () => {
		// boundary after ordinal 1 (u-0) → kept start is ordinal 2 (asst-1).
		expect(findFirstKeptEntryId(entries, 1)).toBe("asst-1");
	});

	it("defers when the kept-start ordinal is a folded-toolResult synthetic user", () => {
		// The folded toolResult is kept-tail content. Advancing past it to asst-2
		// would drop that content, while cutting at it would orphan the result.
		expect(findFirstKeptEntryId(entries, 2)).toBeNull();
	});

	it("falls forward when an unresolvable slot is followed by a real entry", () => {
		const entriesWithUnresolvableSlot = [
			messageEntry("u-0", { role: "user", content: "go" }),
			messageEntry("", { role: "status", content: "non-replayable noise" }),
			messageEntry("u-2", { role: "user", content: "keep this" }),
		];

		expect(findFirstKeptEntryId(entriesWithUnresolvableSlot, 1)).toBe("u-2");
	});

	it("defers (null) when only folded tool-result tails remain after the boundary", () => {
		// Tail ends in a folded toolResult with no following real entry.
		const tailEntries = [
			messageEntry("u-0", { role: "user", content: "go" }),
			messageEntry("asst-1", {
				role: "assistant",
				content: [{ type: "toolCall", id: "tc-1", name: "read" }],
			}),
			messageEntry("tr-1", {
				role: "toolResult",
				toolCallId: "tc-1",
				toolName: "read",
				content: [{ type: "text", text: "out" }],
			}),
		];
		// boundary after ordinal 2 → only the synthetic-user (folded tr-1) tail
		// remains → no replay-safe real entry → defer.
		expect(findFirstKeptEntryId(tailEntries, 2)).toBeNull();
	});
});

describe("findLastModelKeyFromBranch", () => {
	it("returns the LAST model_change as provider/modelId", () => {
		const entries = [
			{ type: "model_change", provider: "openai", modelId: "gpt-5.4" },
			{ type: "message", id: "m1", message: { role: "user" } },
			{ type: "model_change", provider: "anthropic", modelId: "opus-4-8" },
			{ type: "message", id: "m2", message: { role: "assistant" } },
		];
		expect(findLastModelKeyFromBranch(entries)).toBe("anthropic/opus-4-8");
	});

	it("returns undefined when there is no model_change entry (no-regression path)", () => {
		const entries = [
			{ type: "message", id: "m1", message: { role: "user" } },
			{ type: "message", id: "m2", message: { role: "assistant" } },
		];
		expect(findLastModelKeyFromBranch(entries)).toBeUndefined();
	});

	it("ignores malformed model_change entries (missing provider/modelId)", () => {
		expect(
			findLastModelKeyFromBranch([
				{ type: "model_change", provider: "openai" },
			]),
		).toBeUndefined();
		expect(findLastModelKeyFromBranch([])).toBeUndefined();
		expect(findLastModelKeyFromBranch(null)).toBeUndefined();
		expect(findLastModelKeyFromBranch(undefined)).toBeUndefined();
	});
});

describe("convertEntriesToRawMessagePage", () => {
	it("matches full conversion when tool results fold across page boundaries", () => {
		const entry = (id: string, message: Record<string, unknown>) => ({
			type: "message",
			id,
			message,
		});
		const entries = [
			entry("user-1", { role: "user", content: "start" }),
			entry("asst-1", {
				role: "assistant",
				content: [{ type: "toolCall", id: "call-1", name: "read" }],
			}),
			entry("result-1", {
				role: "toolResult",
				toolCallId: "call-1",
				toolName: "read",
				content: [{ type: "text", text: "result" }],
			}),
			entry("asst-2", {
				role: "assistant",
				content: [{ type: "text", text: "continue" }],
			}),
			entry("user-2", { role: "user", content: "finish" }),
		];
		const full = convertEntriesToRawMessages(entries);
		const paged = [
			...convertEntriesToRawMessagePage(entries, 0, 2, full.length),
			...convertEntriesToRawMessagePage(entries, 2, 2, full.length),
			...convertEntriesToRawMessagePage(entries, 4, 2, full.length),
		];

		expect(paged).toEqual(full);
	});

	it("keeps tool output on its carrier when a non-chat entry sits between them", () => {
		const entry = (id: string, message: Record<string, unknown>) => ({
			type: "message",
			id,
			message,
		});
		// A `!cmd` bashExecution entry lands between the tool result and the
		// next chat message: it takes an ordinal of its own, so the folded
		// tool output is carried one ordinal later than the result entry.
		const entries = [
			entry("user-1", { role: "user", content: "start" }),
			entry("asst-1", {
				role: "assistant",
				content: [{ type: "toolCall", id: "call-1", name: "read" }],
			}),
			entry("result-1", {
				role: "toolResult",
				toolCallId: "call-1",
				toolName: "read",
				content: [{ type: "text", text: "TOOL OUTPUT" }],
			}),
			entry("bash-1", {
				role: "bashExecution",
				command: "ls",
				output: "a b",
			}),
			entry("user-2", { role: "user", content: "finish" }),
		];
		const full = convertEntriesToRawMessages(entries);
		const carrier = full.find((message) => message.id === "user-2");
		expect(carrier?.parts).toContainEqual(
			expect.objectContaining({ callID: "call-1" }),
		);

		for (let after = 0; after < full.length; after++) {
			expect(
				convertEntriesToRawMessagePage(entries, after, 1, full.length),
			).toEqual([full[after]]);
		}
	});
});
