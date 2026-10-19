import { expect, test } from "bun:test";
import {
	getOrCreateSessionMeta,
	getPendingOps,
	getTagsBySession,
	queuePendingOp,
	updateSessionMeta,
} from "@magic-context/core/features/magic-context/storage";
import { getMergedReasoningStrippedIds } from "@magic-context/core/features/magic-context/storage-meta-persisted";
import {
	clearContextHandlerSession,
	registerPiContextHandler,
} from "./context-handler";
import {
	assistantMessage,
	createFakePi,
	createTestDb,
	fakeContext,
	toolResultMessage,
	userMessage,
} from "./test-utils.test";

// Check the returned messages, not just whether cleanup was admitted. The
// last provider signature binds every preceding tool result, so reclaiming
// those results must first omit all thinking or refuse the oversized request.
for (const subagent of [false, true]) {
	for (const percent of [85, 95]) {
		test.skipIf(process.env.MC_665_R3 !== "1")(
			`r3 Pi ${subagent ? "subagent" : "primary"} ${percent}% long loop fits or visibly refuses`,
			async () => {
				const db = createTestDb();
				const sessionId = `r3-pi-pressure-${subagent}-${percent}`;
				getOrCreateSessionMeta(db, sessionId);
				updateSessionMeta(db, sessionId, {
					isSubagent: subagent,
					piStableIdScheme: 1,
					cacheTtl: "13h",
					lastResponseTime: Date.now(),
				});
				const fake = createFakePi();
				Object.assign(fake.pi, {
					getAllTools: () => [
						{
							name: "read",
							description: "Read a file",
							parameters: {
								type: "object",
								properties: { path: { type: "string" } },
							},
						},
					],
					getActiveTools: () => ["read"],
				});
				registerPiContextHandler(fake.pi as never, {
					db,
					protectedTokens: 0,
					protectedTools: { read: 0 },
					injection: {
						injectionBudgetTokens: 1000,
						memoryEnabled: false,
						injectDocs: false,
					},
					scheduler: { executeThresholdPercentage: 65 },
					heuristics: { keepReasoningTokens: 10000 },
				});
				const source = [userMessage("read files", 1)];
				const ids = ["user"];
				let pressure = 20;
				const serve = async () => {
					const messages = structuredClone(source);
					const ctx = {
						...fakeContext(sessionId, process.cwd(), ids, messages),
						getSystemPrompt: () => "Read files for this task.",
						model: {
							provider: "anthropic",
							id: "claude-opus-5-5",
							api: "anthropic-messages",
							contextWindow: 100000,
						},
						getContextUsage: () => ({
							tokens: pressure * 1000,
							percent: pressure,
							contextWindow: 100000,
						}),
					};
					return (
						(await fake.handlers.get("context")!(
							{ messages } as never,
							ctx as never,
						)) as { messages: unknown[] }
					).messages;
				};
				try {
					await serve();
					for (let n = 0; n < 8; n++) {
						source.push(
							assistantMessage("", 2 + n * 2, {
								provider: "anthropic",
								model: "claude-opus-5-5",
								api: "anthropic-messages",
								content: [
									{
										type: "thinking",
										thinking: `thought-${n}`,
										thinkingSignature: `sig-${n}`,
									},
									{
										type: "toolCall",
										id: `call-${n}`,
										name: "read",
										arguments: { path: `${n}.txt` },
									},
								],
							}),
							toolResultMessage(
								`call-${n}`,
								"RECLAIMABLE ".repeat(6000),
								3 + n * 2,
							),
						);
						ids.push(`assistant-${n}`, `result-${n}`);
					}
					source.push(
						assistantMessage("", 19, {
							provider: "anthropic",
							model: "claude-opus-5-5",
							api: "anthropic-messages",
							content: [
								{
									type: "thinking",
									thinking: "last boundary",
									thinkingSignature: "sig-last",
								},
							],
						}),
					);
					ids.push("last");
					// Discover and queue tool-result targets only if the first oversized
					// request was not already refused. The window holds 100,000 input tokens.
					expect(JSON.stringify(source).length / 4).toBeGreaterThan(100000);
					pressure = percent;
					let output: unknown[];
					try {
						await serve();
						for (const tag of getTagsBySession(db, sessionId).filter(
							(t) => t.type === "tool",
						))
							queuePendingOp(db, sessionId, tag.tagNumber, "drop");
						output = await serve();
					} catch (error) {
						expect(error).toMatchObject({ name: "EmergencyFailClosedError" });
						console.log(
							`r3 Pi ${subagent}/${percent}: visible EmergencyFailClosedError`,
						);
						return;
					}
					const bytes = JSON.stringify(output);
					expect(bytes.length).toBeLessThan(20000);
					expect(bytes).not.toContain("thinkingSignature");
					expect(getPendingOps(db, sessionId)).toHaveLength(0);
					const omissions = [
						...getMergedReasoningStrippedIds(db, sessionId),
					].filter((id) => id.startsWith("binding_mismatch:"));
					expect(omissions.length).toBeGreaterThanOrEqual(9);
					// Replaying the original messages must not restore removed thinking.
					expect(JSON.stringify(await serve())).not.toContain(
						"thinkingSignature",
					);
					console.log(
						`r3 Pi ${subagent}/${percent}: reset, ${bytes.length} served bytes, ${omissions.length} durable omissions`,
					);
				} finally {
					clearContextHandlerSession(sessionId);
					db.close();
				}
			},
			60000,
		);
	}
}
