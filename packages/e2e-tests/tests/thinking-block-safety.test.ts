/// <reference types="bun-types" />

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { join } from "node:path";
import { TestHarness } from "../src/harness";
import { forEachHost } from "../src/scenario-hosts";
import { openTestDb } from "../src/test-db";

/**
 * E2E regression suite for the Anthropic 400 error family:
 *
 *   "messages.N.content.M: thinking or redacted_thinking blocks in the
 *    latest assistant message cannot be modified. These blocks must remain
 *    as they were in the original response."
 *
 * Three distinct bugs have been observed in production sessions
 * (ses_331acff95fferWZOYF1pG0cjOn is the canonical reproducer). Each bug
 * causes the plugin to mutate content that ultimately becomes part of an
 * assistant block carrying signed thinking. Anthropic re-validates those
 * signatures against the replayed content on every request and rejects the
 * call if anything differs.
 *
 * These tests drive a real `opencode serve` process against a mock Anthropic
 * server that returns thinking blocks with signatures, simulate the plugin-
 * level state that triggered each bug in production, and assert against the
 * exact bytes sent to the mock on the next request.
 *
 *   Bug A — Nudge anchor on a thinking-bearing assistant.
 *           Plugin's reinjectNudgeAtAnchor would append <instruction> text to
 *           the signed assistant's content on every defer pass.
 *           Fix: `hasThinkingBearingParts` guard in nudge-injection.ts.
 *
 *   Bug B — User message shell removal between assistants.
 *           stripDroppedPlaceholderMessages collapsed user turns whose text
 *           became `[dropped §N§]`, causing AI SDK's Anthropic adapter to
 *           merge adjacent assistants and mutate the "latest assistant"
 *           block structure.
 *           Fix: role check in stripDroppedPlaceholderMessages + truncation
 *           path in apply-operations.
 *
 *   Bug C — File/image part stripping when companion text is dropped.
 *           `file` was listed as METADATA in strip-content.ts, so an image-
 *           bearing user message could be stripped entirely when its text
 *           became `[dropped §N§]`, silently deleting the screenshot.
 *           Fix: remove `file` from METADATA_PART_TYPES.
 *
 * All three fixes are verified here end-to-end.
 */

// Shared harness for lightweight tests. Each test resets mock state before
// running so they're independent. One subprocess per file is dramatically
// faster than per-test and still gives full isolation between files.
const RUST_MODE = process.env.MC_E2E_MODE === "rust";

let h: TestHarness;



interface AnthropicContentBlock {
	type: string;
	text?: string;
	thinking?: string;
	signature?: string;
	cache_control?: unknown;
	data?: string;
	source?: { type: string; media_type?: string; data?: string };
}
interface AnthropicMessage {
	role: string;
	content: AnthropicContentBlock[] | string;
}

interface RequestWithMessages {
	body: { messages?: AnthropicMessage[] };
}

/** Cast the loosely-typed `CapturedRequest` to our Anthropic shape. The mock
 * preserves the raw JSON body as-is, so this is safe — it's the same bytes
 * that @ai-sdk/anthropic produced and that the real API would validate. */
function asAnthropic(req: {
	body: Record<string, unknown>;
}): RequestWithMessages {
	return req as unknown as RequestWithMessages;
}

/** Extract assistant messages from captured mock requests. Returns them in
 * the exact order Anthropic received them (which reflects AI SDK's merging).
 */
function capturedAssistants(req: RequestWithMessages): AnthropicMessage[] {
	return (req.body.messages ?? []).filter((m) => m.role === "assistant");
}

function capturedUsers(req: RequestWithMessages): AnthropicMessage[] {
	return (req.body.messages ?? []).filter((m) => m.role === "user");
}

function mainRequests(): Array<{ body: Record<string, unknown> }> {
	return h.mock
		.requests()
		.filter((request) =>
			JSON.stringify(request.body.system ?? "").includes("## Magic Context"),
		);
}

function promptMarker(): string {
	return `[[thinking-block-${crypto.randomUUID()}]]`;
}

function latestUserPromptText(body: Record<string, unknown>): string {
	const messages = Array.isArray(body.messages) ? body.messages : [];
	for (let i = messages.length - 1; i >= 0; i -= 1) {
		const message = messages[i];
		if (
			!message ||
			typeof message !== "object" ||
			(message as { role?: unknown }).role !== "user"
		) {
			continue;
		}
		const content = (message as { content?: unknown }).content;
		if (typeof content === "string" && content.length > 0) return content;
		if (!Array.isArray(content)) continue;
		const text = content
			.map((block) =>
				block && typeof block === "object"
					? (block as { text?: unknown }).text
					: "",
			)
			.filter((value): value is string => typeof value === "string")
			.join("\n");
		if (text.length > 0) return text;
	}
	return "";
}

function selectRequestForMarker<T extends { body: Record<string, unknown> }>(
	requests: readonly T[],
	marker: string,
): T {
	const matching = requests.filter((request) =>
		latestUserPromptText(request.body).includes(marker),
	);
	const request = matching[matching.length - 1];
	if (!request) {
		throw new Error(
			`no Magic Context request contains prompt marker ${marker}`,
		);
	}
	return request;
}

async function mainRequestForMarker(
	marker: string,
): Promise<{ body: Record<string, unknown> }> {
	await h.waitForMockQuiescence({ label: `request capture for ${marker}` });
	return selectRequestForMarker(mainRequests(), marker);
}

async function resetMock(label: string): Promise<void> {
	await h.waitForMockQuiescence({ label: `before mock.reset: ${label}` });
	h.mock.reset();
}

function toolName(
	body: Record<string, unknown>,
	pattern: RegExp,
): string | null {
	const tools = body.tools;
	if (!Array.isArray(tools)) return null;
	for (const tool of tools) {
		if (!tool || typeof tool !== "object") continue;
		const name = (tool as { name?: unknown }).name;
		if (typeof name === "string" && pattern.test(name)) return name;
	}
	return null;
}

function emitCtxReduceOnce(tag: number): () => boolean {
	let emitted = false;
	h.mock.addMatcher((body) => {
		if (
			emitted ||
			!JSON.stringify(body.system ?? "").includes("## Magic Context")
		)
			return null;
		const name = toolName(body, /^ctx_reduce$/);
		if (!name) return null;
		emitted = true;
		return {
			content: [
				{
					type: "tool_use",
					id: `toolu_reduce_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`,
					name,
					input: { drop: String(tag) },
				},
			],
			stop_reason: "tool_use",
			usage: {
				input_tokens: 45_000,
				output_tokens: 20,
				cache_creation_input_tokens: 0,
				cache_read_input_tokens: 0,
			},
		};
	});
	return () => emitted;
}

function tagForText(body: Record<string, unknown>, needle: string): number {
	const messages = body.messages;
	if (!Array.isArray(messages))
		throw new Error("captured request omitted messages");
	for (const message of messages) {
		if (!message || typeof message !== "object") continue;
		const content = (message as { content?: unknown }).content;
		if (!Array.isArray(content)) continue;
		for (const block of content) {
			if (!block || typeof block !== "object") continue;
			const text = (block as { text?: unknown }).text;
			if (typeof text !== "string" || !text.includes(needle)) continue;
			const match = text.match(/§(\d+)§/u);
			if (match) return Number(match[1]);
		}
	}
	throw new Error(`no §N§ tag found for ${JSON.stringify(needle)}`);
}

async function ageTagBeyondProtectedWindow(sessionId: string): Promise<void> {
	await resetMock("age tag beyond protected window");
	h.mock.setDefault({
		text: "aging response",
		usage: {
			input_tokens: 1_000,
			output_tokens: 20,
			cache_creation_input_tokens: 0,
			cache_read_input_tokens: 1_000,
		},
	});
	for (let turn = 0; turn < 6; turn += 1) {
		await h.sendPrompt(sessionId, `aging turn ${turn + 1}`);
	}
}

async function dropAndMaterialize(
	sessionId: string,
	tag: number,
): Promise<{ body: Record<string, unknown>; dropEmitted: boolean }> {
	await resetMock("configure ctx_reduce response");
	const wasDropEmitted = emitCtxReduceOnce(tag);
	h.mock.setDefault({
		text: "after reduce",
		usage: {
			input_tokens: 45_000,
			output_tokens: 20,
			cache_creation_input_tokens: 0,
			cache_read_input_tokens: 0,
		},
	});
	await h.sendPrompt(sessionId, `mark §${tag}§ spent`);

	await resetMock("configure reduced-history materialization");
	h.mock.setDefault({
		text: "after materialization",
		usage: {
			input_tokens: 1_000,
			output_tokens: 20,
			cache_creation_input_tokens: 0,
			cache_read_input_tokens: 1_000,
		},
	});
	const inspectMarker = promptMarker();
	await h.sendPrompt(sessionId, `inspect the reduced history ${inspectMarker}`);
	return {
		body: (await mainRequestForMarker(inspectMarker)).body,
		dropEmitted: wasDropEmitted(),
	};
}

interface ThinkingBlockLocation {
	messageIndex: number;
	block: AnthropicContentBlock;
}

/** Find thinking/redacted_thinking blocks and their provider-wire message positions. */
function findThinkingBlockLocations(
	req: RequestWithMessages,
): ThinkingBlockLocation[] {
	const out: ThinkingBlockLocation[] = [];
	for (const [messageIndex, msg] of (req.body.messages ?? []).entries()) {
		if (!Array.isArray(msg.content)) continue;
		for (const block of msg.content) {
			if (block.type === "thinking" || block.type === "redacted_thinking") {
				out.push({ messageIndex, block });
			}
		}
	}
	return out;
}

/** Find all thinking/redacted_thinking blocks across all messages in a captured request. */
function findThinkingBlocks(req: RequestWithMessages): AnthropicContentBlock[] {
	return findThinkingBlockLocations(req).map(({ block }) => block);
}

forEachHost(import.meta.url, "thinking-block safety (Anthropic 400 regression)", () => {
	beforeAll(async () => {
		h = await TestHarness.create({
			magicContextConfig: {
            // Keep the execute threshold high enough to exercise intermediate
            // nudges without triggering aggressive compaction; tests inject
            // specific usage percentages through mock responses.
				execute_threshold_percentage: 80,
				memory: { auto_search: { enabled: false } },
			},
			modelContextLimit: 50_000,
		});
	});

	afterAll(async () => {
		await h.dispose();
	});
	it("rejects a delayed request that lacks the intended prompt marker", () => {
		const intendedMarker = "[[thinking-block-intended]]";
		const intended = {
			body: { messages: [{ role: "user", content: intendedMarker }] },
		};
		const delayed = {
			body: {
				messages: [{ role: "user", content: "[[thinking-block-prior]]" }],
			},
		};

		expect([intended, delayed][1]).toBe(delayed);
		expect(selectRequestForMarker([intended, delayed], intendedMarker)).toBe(
			intended,
		);
		expect(() => selectRequestForMarker([delayed], intendedMarker)).toThrow(
			"no Magic Context request contains prompt marker",
		);
	});

	describe("Bug A: nudge anchor on a thinking-bearing assistant", () => {
		it("does not inject nudge <instruction> text into an assistant that has a thinking block", async () => {
			await resetMock("start Bug A");

			const signedThinking = "Let me work through this carefully step by step.";
			const signature = "opaque-provider-signature-bug-a";

			// Respond with thinking + text so the assistant message carries
			// a signed thinking block that Anthropic will re-validate.
			h.mock.setDefault({
				content: [
					{ type: "thinking", thinking: signedThinking, signature },
					{ type: "text", text: "Here is the answer." },
				],
				usage: {
					// ~46% of 50K — inside the nudge band so the plugin's
					// reinjectNudgeAtAnchor path is live.
					input_tokens: 23_000,
					output_tokens: 200,
					cache_creation_input_tokens: 0,
					cache_read_input_tokens: 0,
				},
			});

			const sessionId = await h.createSession();
			await h.sendPrompt(sessionId, "turn 1 — establish the thinking block");

			// Establish a nudge placement pointing at the latest assistant
			// by running a second turn at the same usage.
			const anchorMarker = promptMarker();
			await h.sendPrompt(
				sessionId,
				`turn 2 — give nudge logic a chance to anchor ${anchorMarker}`,
			);
			const anchorRequest = await mainRequestForMarker(anchorMarker);

			// Third turn — the defer pass now sees the anchored placement
			// (if any) and MUST NOT mutate the signed assistant's text.
			const finalPromptMarker = promptMarker();
			await h.sendPrompt(
				sessionId,
				`turn 3 — defer pass must not mutate signed msg ${finalPromptMarker}`,
			);

			const mainReqs = h.mock.requests().filter((r) => {
				const sys = r.body.system;
				if (sys === undefined || sys === null) return false;
				const asString = typeof sys === "string" ? sys : JSON.stringify(sys);
				return asString.includes("## Magic Context");
			});
			expect(mainReqs.length).toBeGreaterThanOrEqual(3);

			// On the third request, the assistant history contains both
			// prior turns. Find any assistant message whose content
			// contains a thinking block with our signature.
			const lastReq = await mainRequestForMarker(finalPromptMarker);
			const assistants = capturedAssistants(asAnthropic(lastReq));
			expect(assistants.length).toBeGreaterThan(0);

			let inspected = 0;
			for (const asst of assistants) {
				if (!Array.isArray(asst.content)) continue;
				const hasMatchingSig = asst.content.some(
					(b) => b.type === "thinking" && b.signature === signature,
				);
				if (!hasMatchingSig) continue;
				inspected++;

				// Every text block in this assistant must NOT contain the
				// plugin's nudge instruction markers. Text mutation invalidates
				// the thinking signature.
				for (const block of asst.content) {
					if (block.type !== "text") continue;
					expect(block.text ?? "").not.toContain('<instruction name="context_');
					expect(block.text ?? "").not.toContain("context_iteration");
					expect(block.text ?? "").not.toContain("context_warning");
					expect(block.text ?? "").not.toContain("context_critical");
				}

				// Thinking block content must be exactly what the mock
				// returned — byte-for-byte. This is the strongest invariant.
				const thinking = asst.content.find((b) => b.type === "thinking");
				expect(thinking?.thinking).toBe(signedThinking);
				expect(thinking?.signature).toBe(signature);
			}

			if (RUST_MODE) {
				const request = asAnthropic(lastReq);
				const messages = request.body.messages ?? [];
				let newestAssistantIdx = -1;
				for (const [messageIndex, message] of messages.entries()) {
					if (message.role === "assistant") newestAssistantIdx = messageIndex;
				}
				expect(newestAssistantIdx).toBeGreaterThanOrEqual(0);

				const thinkingLocations = findThinkingBlockLocations(request);
				expect(thinkingLocations.length).toBeGreaterThan(0);
				// Anthropic allows old signed thinking; only the latest assistant's
				// thinking is required to remain intact (https://platform.claude.com/docs/en/build-with-claude/thinking#preserving-thinking-blocks).
				// Fable 5.1 binds thinking to its prefix: stripping a demoted native
				// vector on defer would invalidate later signatures. Rust holds that
				// entire vector until a priced pass, not forever and not for arbitrary
				// historical assistants (https://platform.claude.com/docs/en/build-with-claude/preserved-thinking).
				expect(
					thinkingLocations.map(({ messageIndex }) => messageIndex),
				).toEqual([newestAssistantIdx - 2, newestAssistantIdx]);
				// The adapter moves cache_control to the new cache boundary;
				// compare every content byte apart from that transport annotation.
				const withoutCacheControl = (
					content: AnthropicMessage["content"] | undefined,
				) =>
					Array.isArray(content)
						? content.map(({ cache_control: _cacheControl, ...block }) => block)
						: content;
				expect(withoutCacheControl(assistants[0]?.content)).toEqual(
					withoutCacheControl(
						capturedAssistants(asAnthropic(anchorRequest))[0]?.content,
					),
				);
				for (const { block } of thinkingLocations) {
					expect(block.thinking).toBe(signedThinking);
					expect(block.signature).toBe(signature);
				}
				for (const assistant of assistants) {
					if (!Array.isArray(assistant.content)) continue;
					for (const block of assistant.content) {
						if (block.type !== "text") continue;
						expect(block.text ?? "").not.toContain(
							'<instruction name="context_',
						);
						expect(block.text ?? "").not.toContain("context_iteration");
						expect(block.text ?? "").not.toContain("context_warning");
						expect(block.text ?? "").not.toContain("context_critical");
					}
				}
				// Simulate a stale render configuration in the durable baseline.
				// The next real transform must price that mismatch without a model
				// switch (which makes the adapter drop thinking independently) or
				// compaction (which could hide a leaked hold by deleting its message).
				const store = openTestDb(
					join(
						h.opencode.env.dataDir,
						"cortexkit",
						"magic-context",
						"store.db",
					),
				);
				try {
					const changed = store
						.prepare(
							"UPDATE mc_cache_state SET meta = json_set(meta, '$.last_render_config', 'thinking-safety-stale-config'), row_version = row_version + 1 WHERE session_id = ?",
						)
						.run(sessionId);
					expect(changed.changes).toBe(1);
				} finally {
					store.close();
				}
				h.mock.setDefault({
					content: [
						{ type: "thinking", thinking: signedThinking, signature },
						{ type: "text", text: "Here is the answer." },
					],
					usage: {
						input_tokens: 1_000,
						output_tokens: 200,
						cache_creation_input_tokens: 0,
						cache_read_input_tokens: 1_000,
					},
				});
				const sendFollowupPrompt = async (marker: string) => {
					await h.sendPrompt(sessionId, marker);
				};
				const pricedMarker = promptMarker();
				await sendFollowupPrompt(pricedMarker);
				const priced = asAnthropic(await mainRequestForMarker(pricedMarker));
				const pricedMessages = priced.body.messages ?? [];
				expect(capturedAssistants(priced)).toHaveLength(3);
				const newestPriced = pricedMessages.reduce(
					(latest, message, index) =>
						message.role === "assistant" ? index : latest,
					-1,
				);
				expect(findThinkingBlockLocations(priced)).toEqual([
					{
						messageIndex: newestPriced,
						block: { type: "thinking", thinking: signedThinking, signature },
					},
				]);

				// A subsequent defer may hold the just-demoted assistant, but must
				// never resurrect thinking already stripped by the priced pass.
				const afterMarker = promptMarker();
				await sendFollowupPrompt(afterMarker);
				const after = asAnthropic(await mainRequestForMarker(afterMarker));
				const newestAfter = (after.body.messages ?? []).reduce(
					(latest, message, index) =>
						message.role === "assistant" ? index : latest,
					-1,
				);
				expect(findThinkingBlockLocations(after)).toEqual([
					{
						messageIndex: newestAfter - 2,
						block: { type: "thinking", thinking: signedThinking, signature },
					},
					{
						messageIndex: newestAfter,
						block: { type: "thinking", thinking: signedThinking, signature },
					},
				]);
			} else {
				// TypeScript preserves historical signed reasoning, so this branch must
				// inspect at least one real signature rather than passing vacuously.
				expect(inspected).toBeGreaterThan(0);
			}
		}, 90_000);
	});

	describe("Bug B: user-message turn boundary preserved when text tag is dropped", () => {
		it(RUST_MODE
			? "keeps provider roles safe when whole-arc history supersedes the dropped shell"
			: "keeps the user shell as [dropped §N§] so adjacent assistants are not merged", async () => {
			await resetMock("start Bug B");

			const signedThinkingA = "First thinking block for turn one.";
			const signedThinkingB = "Second thinking block for turn two.";
			const sigA = "sig-bug-b-turn-one";
			const sigB = "sig-bug-b-turn-two";

			h.mock.script([
				{
					content: [
						{ type: "thinking", thinking: signedThinkingA, signature: sigA },
						{ type: "text", text: "Response to turn 1." },
					],
					usage: {
						input_tokens: 15_000,
						output_tokens: 100,
						cache_creation_input_tokens: 0,
						cache_read_input_tokens: 0,
					},
				},
				{
					content: [
						{ type: "thinking", thinking: signedThinkingB, signature: sigB },
						{ type: "text", text: "Response to turn 2." },
					],
					usage: {
						input_tokens: 18_000,
						output_tokens: 100,
						cache_creation_input_tokens: 10_000,
						cache_read_input_tokens: 5_000,
					},
				},
			]);
			h.mock.setDefault({
				content: [{ type: "text", text: "follow-up" }],
				usage: {
					input_tokens: 19_000,
					output_tokens: 50,
					cache_creation_input_tokens: 10_000,
					cache_read_input_tokens: 9_000,
				},
			});

			const sessionId = await h.createSession();

			// Turn 1 — short user, assistant has thinking.
			await h.sendPrompt(sessionId, "please explain how the drop logic works");

			// Turn 2 — a MASSIVE user paste that we'll drop afterwards.
			const paste = `Here is a log of the failing session:\n${"ERROR: call_failed at line 42.\n".repeat(
				60,
			)}`;
			const pasteMarker = promptMarker();
			await h.sendPrompt(sessionId, `${paste}\n${pasteMarker}`);

			// Resolve the public §N§ handle from the exact wire bytes, then drop it
			// through ctx_reduce. This avoids coupling either mode to its private store.
			const pasteTag = tagForText(
				(await mainRequestForMarker(pasteMarker)).body,
				"Here is a log of the failing session:",
			);
			await ageTagBeyondProtectedWindow(sessionId);
			const reduced = await dropAndMaterialize(sessionId, pasteTag);
			expect(reduced.dropEmitted).toBe(true);
			const lastReq = { body: reduced.body };

			// Unless Rust has published a covering history summary, keep the
			// dropped paste's user shell so adjacent assistants cannot merge.
			const users = capturedUsers(asAnthropic(lastReq));
			const allUserText = users
				.flatMap((u) => (Array.isArray(u.content) ? u.content : []))
				.filter((b) => b.type === "text")
				.map((b) => b.text ?? "")
				.join("\n");

			expect(allUserText).not.toContain("ERROR: call_failed at line 42.");
			if (RUST_MODE) {
				// A published Rust session-history summary supersedes the
				// covered dropped shell and historical assistants together.
				expect(allUserText).toContain("<session-history>");
			} else {
				expect(allUserText).toMatch(/\[dropped \u00a7\d+\u00a7\]/);
			}

			// TypeScript replays historical thinking unchanged; Rust removes
			// reasoning from the history covered by its published summary.
			const thinkings = findThinkingBlocks(asAnthropic(lastReq));
			const signatures = new Set(thinkings.map((t) => t.signature));
			// TypeScript must replay at least one mock signature.
			const hasSigA = signatures.has(sigA);
			const hasSigB = signatures.has(sigB);
			if (RUST_MODE) {
				// Rust clears historical reasoning blocks instead of replaying them.
				expect(thinkings).toHaveLength(0);
			} else {
				expect(hasSigA || hasSigB).toBe(true);
			}

			// For every replayed signed thinking, its text is byte-identical.
			for (const t of thinkings) {
				if (t.signature === sigA) expect(t.thinking).toBe(signedThinkingA);
				if (t.signature === sigB) expect(t.thinking).toBe(signedThinkingB);
			}

			const messages = (lastReq.body.messages ?? []) as Array<{ role: string }>;
			if (RUST_MODE) {
				// Covered history no longer has raw turn shells, but it must also
				// never expose adjacent assistants for the adapter to merge.
				for (let i = 1; i < messages.length; i++) {
					expect([messages[i - 1]!.role, messages[i]!.role]).not.toEqual([
						"assistant",
						"assistant",
					]);
				}
			} else {
				// The raw user paste shell remains a distinct boundary. Count
				// transitions to prove adjacent assistants were not merged.
				const transitions: Array<{ from: string; to: string }> = [];
				for (let i = 1; i < messages.length; i++) {
					const prev = messages[i - 1]!;
					const cur = messages[i]!;
					if (prev.role !== cur.role) {
						transitions.push({ from: prev.role, to: cur.role });
					}
				}
				const userToAsst = transitions.filter(
					(t) => t.from === "user" && t.to === "assistant",
				);
				expect(userToAsst.length).toBeGreaterThanOrEqual(2);
			}
		}, 120_000);
	});

	describe("Bug C: file/image part survives when companion text is dropped", () => {
		it(RUST_MODE
			? "allows whole-arc history to supersede the image without partial stripping"
			: "keeps a user message with an image part even after its text tag is dropped", async () => {
			await resetMock("start Bug C");
			h.mock.setDefault({
				content: [{ type: "text", text: "I see the screenshot." }],
				usage: {
					input_tokens: 22_000,
					output_tokens: 50,
					cache_creation_input_tokens: 0,
					cache_read_input_tokens: 0,
				},
			});

			const sessionId = await h.createSession();

			// Drive an OpenCode prompt carrying both text + a file part.
			// We bypass the SdkClient helper (text-only) and call the raw
			// client to include a file part.
			const sdk = await import("@opencode-ai/sdk");
			const rawClient = sdk.createOpencodeClient({
				baseUrl: h.opencode.url,
			}) as unknown as {
				session: {
					prompt: (opts: {
						path: { id: string };
						body: {
							model: { providerID: string; modelID: string };
							parts: Array<{
								type: "text" | "file";
								text?: string;
								mime?: string;
								url?: string;
								filename?: string;
							}>;
						};
					}) => Promise<unknown>;
				};
			};

			// 1x1 transparent PNG data URL.
			const imageDataUrl =
				"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

			const imagePromptMarker = promptMarker();
			await rawClient.session.prompt({
				path: { id: sessionId },
				body: {
					model: { providerID: "mock-anthropic", modelID: "mock-sonnet" },
					parts: [
						{
							type: "text",
							text: `see this screenshot for the bug ${imagePromptMarker}`,
						},
						{
							type: "file",
							mime: "image/png",
							url: imageDataUrl,
							filename: "bug.png",
						},
					],
				},
			});
			h.assertMagicContextProcessed(sessionId);

			// Drop only the text block via its public §N§ handle. Its sibling
			// image must survive unless a Rust summary covers the whole message.
			const userTextTag = tagForText(
				(await mainRequestForMarker(imagePromptMarker)).body,
				"see this screenshot for the bug",
			);
			await ageTagBeyondProtectedWindow(sessionId);
			const reduced = await dropAndMaterialize(sessionId, userTextTag);
			expect(reduced.dropEmitted).toBe(true);
			const lastReq = { body: reduced.body };

			// Outside Rust history coverage, the image must remain in a user
			// content array. The adapter can encode data URLs as either base64
			// or source.type:"url" without media_type; accept either shape.
			const users = capturedUsers(asAnthropic(lastReq));
			const allUserBlocks = users.flatMap((u) =>
				Array.isArray(u.content) ? u.content : [],
			);
			const imageBlocks = allUserBlocks.filter((b) => b.type === "image");
			const allUserText = allUserBlocks
				.filter((block) => block.type === "text")
				.map((block) => block.text ?? "")
				.join("\n");
			expect(allUserText).not.toContain("see this screenshot for the bug");

			const coveredByRustHistory =
				RUST_MODE && allUserText.includes("<session-history>");
			if (coveredByRustHistory) {
				// A published Rust session-history summary owns every raw block
				// in its range, superseding both the text shell and image.
				expect(imageBlocks).toHaveLength(0);
			} else {
				expect(imageBlocks.length).toBeGreaterThan(0);
				expect(allUserText).toMatch(/\[dropped \u00a7\d+\u00a7\]/);

				// Before coverage, the user message carrying the image must remain
				// structurally present after dropping only its companion text.
				const userWithImage = users.find(
					(u) =>
						Array.isArray(u.content) &&
						u.content.some((b) => b.type === "image"),
				);
				expect(userWithImage).toBeDefined();
			}
		}, 90_000);
	});
});
