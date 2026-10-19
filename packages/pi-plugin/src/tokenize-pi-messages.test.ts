import { describe, expect, test } from "bun:test";
import { tokenizePiMessages } from "./tokenize-pi-messages";

/**
 * Regression coverage for the Pi `/ctx-status` Tool Calls bug.
 *
 * Symptom: dialog showed `Tool Calls: 1.1M (650.6%)` on a 162K-token
 * context — mathematically impossible. Root cause: the dialog walked
 * `ctx.sessionManager.getBranch()`, which returns the FULL leaf-to-root
 * path including pre-compaction-marker entries. Those pre-compaction
 * tool calls/results were never tagged (predate the marker), so they
 * couldn't be filtered out of the count.
 *
 * Fix: the pipeline now persists token totals from the post-compaction
 * `event.messages` view (the same one tagger sees), and the dialog
 * reads the persisted value instead of re-walking `getBranch()`.
 *
 * These tests pin the `tokenizePiMessages()` function — the source of
 * truth for what gets persisted. Each test asserts the tool-call vs
 * conversation partitioning matches OpenCode's per-part categorization
 * in `transform.ts:1028-1119`.
 */

describe("tokenizePiMessages", () => {
	test("user text → conversation bucket", () => {
		const counts = tokenizePiMessages([
			{
				role: "user",
				content: [{ type: "text", text: "hello world" }],
			},
		]);
		expect(counts.conversation).toBeGreaterThan(0);
		expect(counts.toolCall).toBe(0);
	});

	test("user content as plain string → conversation bucket", () => {
		// Pi accepts user.content as either an array OR a bare string.
		const counts = tokenizePiMessages([
			{ role: "user", content: "hello world" },
		]);
		expect(counts.conversation).toBeGreaterThan(0);
		expect(counts.toolCall).toBe(0);
	});

	test("assistant thinking → conversation bucket (signature is identity, not prose)", () => {
		const counts = tokenizePiMessages([
			{
				role: "assistant",
				content: [
					{
						type: "thinking",
						thinking: "let me consider this",
						thinkingSignature: "sig-block-data",
					},
				],
			},
		]);
		expect(counts.conversation).toBeGreaterThan(0);
		expect(counts.toolCall).toBe(0);
		const unsigned = tokenizePiMessages([
			{
				role: "assistant",
				content: [{ type: "thinking", thinking: "let me consider this" }],
			},
		]);
		expect(counts).toEqual(unsigned);
		expect(
			tokenizePiMessages([
				{
					role: "assistant",
					content: [
						{
							type: "thinking",
							thinking: "let me consider this",
							thinkingSignature: "opaque".repeat(50_000),
						},
					],
				},
			]),
		).toEqual(unsigned);
	});

	test("opaque thinking uses output usage or a fixed unknown-step fallback", () => {
		const content = [
			{
				type: "thinking",
				thinking: "",
				thinkingSignature: "opaque".repeat(50_000),
			},
		];
		expect(
			tokenizePiMessages([{ role: "assistant", content }]).conversation,
		).toBe(1000);
		expect(
			tokenizePiMessages([
				{ role: "assistant", content, usage: { output: 456 } },
			]).conversation,
		).toBe(456);
		expect(
			tokenizePiMessages([
				{
					role: "assistant",
					content: [
						{ type: "redacted_thinking", data: "opaque".repeat(50_000) },
					],
				},
			]).conversation,
		).toBe(1000);
	});

	test("assistant toolCall → toolCall bucket (name + JSON args)", () => {
		const counts = tokenizePiMessages([
			{
				role: "assistant",
				content: [
					{
						type: "toolCall",
						id: "call_abc",
						name: "read",
						arguments: { path: "/some/file/path.ts" },
					},
				],
			},
		]);
		expect(counts.conversation).toBe(0);
		expect(counts.toolCall).toBeGreaterThan(0);
	});

	test("toolResult role → toolCall bucket (the bulky result body)", () => {
		// The result body dominates the bucket. Real `read` results are
		// often kilobytes. Confirm a reasonable text result lands in
		// toolCall, not conversation. Use varied content because
		// repeated single chars compress unrealistically well under a
		// real BPE tokenizer.
		const bigResult = Array.from(
			{ length: 200 },
			(_, i) => `line ${i}: data ${i * 7}`,
		).join("\n");
		const counts = tokenizePiMessages([
			{
				role: "toolResult",
				toolCallId: "call_abc",
				content: [{ type: "text", text: bigResult }],
			},
		]);
		expect(counts.conversation).toBe(0);
		expect(counts.toolCall).toBeGreaterThan(100);
	});

	test("toolResult with bare-string content → toolCall bucket", () => {
		const counts = tokenizePiMessages([
			{
				role: "toolResult",
				toolCallId: "call_abc",
				content: "result body as string",
			},
		]);
		expect(counts.conversation).toBe(0);
		expect(counts.toolCall).toBeGreaterThan(0);
	});

	test("dropped sentinels tokenize to ~few tokens (NOT the original bulk)", () => {
		// After the pipeline drops a tool tag, the toolResult content is
		// replaced with `[dropped §N§]`. Confirm this tokenizes small —
		// proves the post-strip walk reflects what the LLM actually sees.
		const counts = tokenizePiMessages([
			{
				role: "toolResult",
				toolCallId: "call_abc",
				content: [{ type: "text", text: "[dropped §42§]" }],
			},
		]);
		expect(counts.toolCall).toBeLessThan(20);
	});

	test("mixed conversation + tool I/O → both buckets populated", () => {
		const counts = tokenizePiMessages([
			{ role: "user", content: [{ type: "text", text: "read foo.ts" }] },
			{
				role: "assistant",
				content: [
					{
						type: "toolCall",
						id: "call_1",
						name: "read",
						arguments: { path: "/foo.ts" },
					},
				],
			},
			{
				role: "toolResult",
				toolCallId: "call_1",
				content: [{ type: "text", text: "file contents here" }],
			},
			{
				role: "assistant",
				content: [{ type: "text", text: "Done." }],
			},
		]);
		expect(counts.conversation).toBeGreaterThan(0);
		expect(counts.toolCall).toBeGreaterThan(0);
	});

	test("empty array → both zero (no NaN, no throw)", () => {
		const counts = tokenizePiMessages([]);
		expect(counts.conversation).toBe(0);
		expect(counts.toolCall).toBe(0);
	});

	test("malformed entries are skipped without throwing", () => {
		const counts = tokenizePiMessages([
			null,
			undefined,
			"junk",
			{ role: "assistant" }, // no content
			{ role: "assistant", content: null },
			{ role: "user", content: [null, { type: "text" }] }, // no text field
		] as unknown[]);
		expect(counts.conversation).toBe(0);
		expect(counts.toolCall).toBe(0);
	});

	test("image content → conversation bucket (visual fallback)", () => {
		// Pi image content is base64 without dimensions at this layer;
		// use OpenCode's fallback constant of 1200 tokens per image.
		const counts = tokenizePiMessages([
			{
				role: "user",
				content: [{ type: "image", data: "abc==", mimeType: "image/png" }],
			},
		]);
		expect(counts.conversation).toBe(1200);
		expect(counts.toolCall).toBe(0);
	});

	test("image inside toolResult → toolCall bucket", () => {
		// Tool that returns an image (e.g. screenshot) — the visual
		// tokens should land in the tool bucket, not conversation.
		const counts = tokenizePiMessages([
			{
				role: "toolResult",
				toolCallId: "call_screenshot",
				content: [{ type: "image", data: "xyz==", mimeType: "image/png" }],
			},
		]);
		expect(counts.conversation).toBe(0);
		expect(counts.toolCall).toBe(1200);
	});

	test("stable-id cache reuses equal token fields and invalidates changed content", () => {
		const cache = new Map();
		const stableId = () => "entry-1";
		const first = tokenizePiMessages(
			[{ role: "user", content: [{ type: "text", text: "cached text" }] }],
			{ cache, stableId },
		);
		const cachedEntry = cache.get("entry-1");
		const equalClone = tokenizePiMessages(
			[{ role: "user", content: [{ type: "text", text: "cached text" }] }],
			{ cache, stableId },
		);
		expect(equalClone).toEqual(first);
		expect(cache.get("entry-1")).toBe(cachedEntry);

		const changed = tokenizePiMessages(
			[
				{
					role: "user",
					content: [
						{ type: "text", text: "cached text with a longer changed suffix" },
					],
				},
			],
			{ cache, stableId },
		);
		expect(changed.conversation).toBeGreaterThan(first.conversation);
		expect(cache.get("entry-1")).not.toBe(cachedEntry);
	});

	test("toJSON-bearing messages bypass stable-id cache equality", () => {
		const cache = new Map();
		const stableId = () => "entry-to-json";
		const cachedText = "short cached text";
		const first = tokenizePiMessages([{ role: "user", content: cachedText }], {
			cache,
			stableId,
		});
		const customMessage = {
			role: "user",
			content: "a much larger actual token payload ".repeat(80),
			toJSON() {
				return { role: "user", content: cachedText };
			},
		};

		const recounted = tokenizePiMessages([customMessage], { cache, stableId });
		expect(recounted.conversation).toBeGreaterThan(first.conversation);
		expect(cache.has("entry-to-json")).toBe(false);
	});

	test("nested toJSON-bearing parts bypass stable-id cache equality", () => {
		const cache = new Map();
		const stableId = () => "entry-nested-to-json";
		const shortText = "short cached text";
		const first = tokenizePiMessages(
			[{ role: "user", content: [{ type: "text", text: shortText }] }],
			{ cache, stableId },
		);
		const customPart = {
			type: "text",
			text: "a much larger actual token payload ".repeat(80),
			toJSON() {
				return { type: "text", text: shortText };
			},
		};

		const recounted = tokenizePiMessages(
			[{ role: "user", content: [customPart] }],
			{ cache, stableId },
		);
		expect(recounted.conversation).toBeGreaterThan(first.conversation);
		expect(cache.has("entry-nested-to-json")).toBe(false);
	});

	test("non-enumerable tokenizer fields bypass stable-id cache equality", () => {
		const cache = new Map();
		const stableId = () => "entry-hidden-fields";
		tokenizePiMessages([{}], { cache, stableId });
		const hiddenMessage = Object.create(null) as Record<string, unknown>;
		Object.defineProperties(hiddenMessage, {
			role: { value: "user", enumerable: false },
			content: {
				value: "hidden content that must be tokenized ".repeat(40),
				enumerable: false,
			},
		});

		const recounted = tokenizePiMessages([hiddenMessage], { cache, stableId });
		expect(recounted.conversation).toBeGreaterThan(0);
		expect(cache.has("entry-hidden-fields")).toBe(false);
	});

	test("stable-id cache prunes messages outside the live wire", () => {
		const cache = new Map([
			[
				"old-entry",
				{ fingerprint: [], counts: { conversation: 0, toolCall: 0 } },
			],
		]);
		const message = { role: "user", content: "live" };
		tokenizePiMessages([message], {
			cache,
			stableId: () => "live-entry",
		});
		expect(cache.has("old-entry")).toBe(false);
		expect(cache.has("live-entry")).toBe(true);
	});

	test("image payload changes reuse the fixed visual token count", () => {
		const cache = new Map();
		const stableId = () => "entry-image";
		const first = tokenizePiMessages(
			[
				{
					role: "user",
					content: [
						{ type: "image", data: "first-payload", mimeType: "image/png" },
					],
				},
			],
			{ cache, stableId },
		);
		const cachedEntry = cache.get("entry-image");
		const changedPayload = tokenizePiMessages(
			[
				{
					role: "user",
					content: [
						{
							type: "image",
							data: "different-payload",
							mimeType: "image/jpeg",
						},
					],
				},
			],
			{ cache, stableId },
		);
		expect(changedPayload).toEqual(first);
		expect(cache.get("entry-image")).toBe(cachedEntry);
	});

	test("toolCall args as pre-stringified JSON → toolCall bucket", () => {
		// Some Pi providers may stringify arguments before storing.
		const counts = tokenizePiMessages([
			{
				role: "assistant",
				content: [
					{
						type: "toolCall",
						id: "call_pre",
						name: "fetch",
						arguments: '{"url":"https://example.com/api"}',
					},
				],
			},
		]);
		expect(counts.toolCall).toBeGreaterThan(0);
	});
});
