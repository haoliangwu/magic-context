import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { spawn } from "node:child_process";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendCompartments } from "@magic-context/core/features/magic-context/compartment-storage";
import {
	getTagsBySession,
	queuePendingOp,
	updateSessionMeta,
} from "@magic-context/core/features/magic-context/storage";
import * as reasoningStorage from "@magic-context/core/features/magic-context/storage-meta-persisted";
import {
	recordOverflowDetected,
	resetEmergencyRecoveryRegistryForTest,
} from "@magic-context/core/features/magic-context/storage-meta-persisted";
import { __test as decisionLogInternals } from "@magic-context/core/features/magic-context/transform-decision-log";
import { EmergencyFailClosedError } from "@magic-context/core/hooks/magic-context/emergency-fail-closed";
import {
	dropSlot,
	getInMemorySlot,
	resetLkgSlotsForTest,
} from "@magic-context/core/hooks/magic-context/lkg-slot";
import { Database } from "@magic-context/core/shared/sqlite";
import { closeQuietly } from "@magic-context/core/shared/sqlite-helpers";
import { createTestTempDirFromPath } from "../../plugin/src/shared/test-temp-dir";

import {
	clearContextHandlerSession,
	__test as contextHandlerInternals,
	registerPiContextHandler,
} from "./context-handler";
import { setPiTransformTimingObserver } from "./context-perf-hooks";
import { contextHost } from "./pi-context-host.test";
import { reconcilePiLkgEntryIds } from "./pi-lkg";
import {
	assistantMessage,
	assistantToolCall,
	createFakePi,
	createTestDb,
	fakeContext,
	textOf,
	toolResultMessage,
	userMessage,
} from "./test-utils.test";

type PiHandler = (
	event: { messages: never[] },
	ctx: never,
) => Promise<{ messages: never[] } | undefined>;

function handlerFor(
	db: ReturnType<typeof createTestDb>,
	host?: ReturnType<typeof contextHost>,
): PiHandler {
	const fake = createFakePi();
	if (host) Object.assign(fake.pi, host.api);
	registerPiContextHandler(fake.pi as never, { db });
	return fake.handlers.get("context") as PiHandler;
}

async function runPass(
	handler: PiHandler,
	sessionId: string,
	messages: unknown[],
	entryIds: string[],
): Promise<{ messages: never[] } | undefined> {
	return handler(
		{ messages: messages as never[] },
		fakeContext(sessionId, process.cwd(), entryIds, messages as never) as never,
	);
}

function nextImmediate(): Promise<void> {
	return new Promise((resolve) => setImmediate(resolve));
}

describe("Pi LKG JSONL entry-id projection", () => {
	it("fills only unambiguous spans between stable JSONL anchors", () => {
		expect(
			reconcilePiLkgEntryIds(
				["entry-1", undefined, "entry-3", undefined, "entry-5"],
				["entry-1", "entry-2", "entry-3", "entry-4", "entry-5", "extra"],
			),
		).toEqual(["entry-1", "entry-2", "entry-3", "entry-4", "entry-5"]);
	});
});

describe("Pi context handler LKG replay", () => {
	const tempDirs: string[] = [];
	const sessions = new Set<string>();

	afterEach(() => {
		for (const sessionId of sessions) clearContextHandlerSession(sessionId);
		sessions.clear();
		resetLkgSlotsForTest();
		resetEmergencyRecoveryRegistryForTest();
		for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
		tempDirs.length = 0;
	});

	for (const tailKind of ["prose and result", "two results"] as const) {
		it(`preserves complete busy recovery bytes on healthy passes (${tailKind})`, async () => {
			const dir = createTestTempDirFromPath(join(tmpdir(), "pi-lkg-handoff-"));
			tempDirs.push(dir);
			const path = join(dir, "context.db");
			const db = createTestDb(path);
			const locker = new Database(path);
			const sessionId = `pi-lkg-handoff-${tailKind}`;
			sessions.add(sessionId);
			try {
				updateSessionMeta(db, sessionId, {
					piStableIdScheme: 1,
					systemPromptHash: "sys-v1",
				});
				const fake = createFakePi();
				Object.assign(fake.pi, { getAllTools: () => [] });
				registerPiContextHandler(fake.pi as never, {
					db,
					protectedTags: 0,
					injection: { injectionBudgetTokens: 10000 },
					scheduler: { executeThresholdPercentage: 80 },
				});
				const handler = fake.handlers.get("context") as PiHandler;
				let systemPrompt = "Complete system prompt.";
				const pass = (raw: unknown[], ids: string[]) => {
					const ctx = fakeContext(sessionId, dir, ids, raw as never);
					Object.assign(ctx, {
						getSystemPrompt: () => systemPrompt,
						model: {
							provider: "openai-codex",
							id: "gpt-5.6-sol",
							contextWindow: 272000,
							maxTokens: 68000,
						},
					});
					return handler({ messages: raw as never[] }, ctx as never);
				};
				const head = [userMessage("original prompt", 1)];
				if (tailKind === "two results") {
					const calls = assistantToolCall("call-1", "Read", {}, 2);
					(calls as { content: unknown[] }).content.push({
						type: "toolCall",
						id: "call-2",
						name: "Read",
						arguments: {},
					});
					head.push(calls);
				}
				const headIds = head.map((_, i) => `head-${i}`);
				const first = await pass(structuredClone(head), headIds);
				expect(first).toBeDefined();
				await nextImmediate();
				updateSessionMeta(db, sessionId, {
					lastResponseTime: Date.now(),
					cacheTtl: "59m",
					lastContextPercentage: 4,
					lastInputTokens: 4000,
				});
				const prose = assistantToolCall("call-1", "Read", {}, 2);
				(prose as { content: unknown[] }).content.unshift({
					type: "text",
					text: "I'll refresh the drafts.",
				});
				const tail =
					tailKind === "two results"
						? [
								toolResultMessage("call-1", "Created new file.", 3),
								toolResultMessage("call-2", "Created new work.", 4),
							]
						: [
								prose,
								toolResultMessage("call-1", "ca92ad8f\ncommand output", 3),
							];
				const raw = [...head, ...tail];
				const ids = [...headIds, "tail-1", "tail-2"];
				const tagsBefore = db
					.query("SELECT * FROM tags WHERE session_id = ? ORDER BY id")
					.all(sessionId);
				db.exec("PRAGMA busy_timeout=0");
				locker.exec("BEGIN IMMEDIATE");
				const busy = await pass(structuredClone(raw), ids);
				expect(busy).toBeDefined();
				if (!busy || !first) throw new Error("Expected served recovery");
				expect(JSON.stringify(busy.messages)).toBe(
					JSON.stringify([...first.messages, ...tail]),
				);
				expect(
					db
						.query("SELECT * FROM tags WHERE session_id = ? ORDER BY id")
						.all(sessionId),
				).toEqual(tagsBefore);
				locker.exec("ROLLBACK");
				const healthy = await pass(
					[...structuredClone(raw), userMessage("new turn", 5)],
					[...ids, "new-1"],
				);
				if (!healthy) throw new Error("Expected healthy pass");
				expect(
					JSON.stringify(healthy.messages.slice(0, busy.messages.length)),
				).toBe(JSON.stringify(busy.messages));
				expect(textOf(healthy.messages.at(-1))).toMatch(/^§\d+§ new turn/);
				const repeated = await pass(
					[
						...structuredClone(raw),
						userMessage("new turn", 5),
						userMessage("next turn", 6),
					],
					[...ids, "new-1", "new-2"],
				);
				expect(
					JSON.stringify(repeated?.messages.slice(0, healthy.messages.length)),
				).toBe(JSON.stringify(healthy.messages));
				for (let passIndex = 0; passIndex < 3; passIndex++)
					expect(
						JSON.stringify(
							(
								await pass(
									[
										...structuredClone(raw),
										userMessage("new turn", 5),
										userMessage("next turn", 6),
									],
									[...ids, "new-1", "new-2"],
								)
							)?.messages,
						),
					).toBe(JSON.stringify(repeated?.messages));
				updateSessionMeta(db, sessionId, { systemPromptHash: "sys-v2" });
				systemPrompt = "Changed complete system prompt.";
				const foldRaw = [
					...structuredClone(raw),
					userMessage("new turn", 5),
					userMessage("next turn", 6),
				];
				const foldIds = [...ids, "new-1", "new-2"];
				const folded = await pass(structuredClone(foldRaw), foldIds);
				const results =
					folded?.messages.filter(
						(message) => (message as { role: string }).role === "toolResult",
					) ?? [];
				expect(results).toHaveLength(tailKind === "two results" ? 2 : 1);
				for (const message of results) {
					expect(textOf(message)).toMatch(/^§\d+§ /);
					expect(textOf(message).match(/§\d+§/g)).toHaveLength(1);
				}
				const decision = decisionLogInternals.getPendingPi(sessionId);
				expect(decision?.lkgFrozenReleaseReason).toBe(
					"recovery_tail_normalized",
				);
				if (!decision) throw new Error("Expected normalization decision");
				decisionLogInternals.writeRow(path, {
					...decision,
					sessionId,
					harness: "pi",
					messageId: "fold-proof",
				});
				expect(
					(
						db
							.query(
								"SELECT materialize_reason FROM transform_decisions WHERE session_id = ?",
							)
							.get(sessionId) as { materialize_reason: string }
					).materialize_reason,
				).toContain("recovery_tail_normalized");
				const normalizedTags = getTagsBySession(db, sessionId);
				expect(
					JSON.stringify(
						(await pass(structuredClone(foldRaw), foldIds))?.messages,
					),
				).toBe(JSON.stringify(folded?.messages));
				expect(getTagsBySession(db, sessionId)).toEqual(normalizedTags);
				const toolTag = getTagsBySession(db, sessionId).find(
					(tag) => tag.type === "tool" && tag.messageId === "call-1",
				);
				if (!toolTag) throw new Error("Expected normalized tool target");
				queuePendingOp(db, sessionId, toolTag.tagNumber, "drop", 1);
				updateSessionMeta(db, sessionId, { systemPromptHash: "sys-v3" });
				systemPrompt = "Third complete system prompt.";
				await pass(structuredClone(foldRaw), foldIds);
				expect(
					getTagsBySession(db, sessionId).find(
						(tag) => tag.tagNumber === toolTag.tagNumber,
					)?.status,
				).toBe("dropped");
			} finally {
				if (locker.inTransaction) locker.exec("ROLLBACK");
				closeQuietly(locker);
				closeQuietly(db);
			}
		});
	}

	for (const change of [
		"content mismatch",
		"branch contraction",
		"restart",
		"branch revert",
		"model switch",
		"session clear",
		"other session",
		"signed restart",
		"signed content mismatch",
		"signed active restart",
		"signed active content mismatch",
		"signed content mismatch persistence failure",
		"signed content mismatch multiple completed turns",
	] as const) {
		it(`rebuilds an unproven recovery prefix after ${change}`, async () => {
			const dir = createTestTempDirFromPath(join(tmpdir(), "pi-lkg-unproven-"));
			tempDirs.push(dir);
			const db = createTestDb(join(dir, "context.db"));
			const locker = new Database(join(dir, "context.db"));
			const sessionId = `pi-lkg-unproven-${change}`;
			sessions.add(sessionId);
			try {
				updateSessionMeta(db, sessionId, { piStableIdScheme: 1 });
				const fake = createFakePi();
				Object.assign(fake.pi, { getAllTools: () => [] });
				registerPiContextHandler(fake.pi as never, { db });
				const handler = fake.handlers.get("context") as PiHandler;
				let switched = false;
				let activeSessionId = sessionId;
				const signed = change.startsWith("signed");
				const pass = (raw: unknown[], ids: string[]) => {
					const ctx = fakeContext(activeSessionId, dir, ids, raw as never);
					Object.assign(ctx, {
						getSystemPrompt: () => "Complete system.",
						model: {
							provider: signed ? "anthropic" : "openai-codex",
							id: signed
								? "claude-opus-5-5"
								: switched
									? "gpt-5.7"
									: "gpt-5.6-sol",
							contextWindow: 272000,
							maxTokens: 68000,
						},
					});
					return handler({ messages: raw as never[] }, ctx as never);
				};
				await pass([userMessage("head", 1)], ["head"]);
				await nextImmediate();
				const raw = [userMessage("head", 1), assistantMessage("served raw", 2)];
				if (signed) {
					Object.assign(raw[1], {
						api: "anthropic-messages",
						provider: "anthropic",
						model: "claude-opus-5-5",
					});
					(raw[1] as { content: unknown[] }).content.unshift({
						type: "thinking",
						thinking: "bound thought",
						thinkingSignature: "signed-proof",
					});
					raw.splice(1, 0, assistantMessage("unsigned before signature", 1.5));
					if (change.includes("multiple")) {
						const older = assistantMessage("another signed reply", 2.5);
						(older as { content: unknown[] }).content.unshift({
							type: "thinking",
							thinking: "second bound thought",
							thinkingSignature: "signed-proof-2",
						});
						raw.push(older);
					}
				}
				const rawIds = raw.map((_, index) =>
					index === 0 ? "head" : `tail-${index}`,
				);
				db.exec("PRAGMA busy_timeout=0");
				locker.exec("BEGIN IMMEDIATE");
				const busy = await pass(structuredClone(raw), rawIds);
				expect(textOf(busy?.messages.at(-1))).toBe(
					change.includes("multiple") ? "another signed reply" : "served raw",
				);
				locker.exec("ROLLBACK");
				let nextRaw = raw;
				let nextIds = rawIds;
				if (change.includes("content mismatch"))
					nextRaw = signed
						? [userMessage("edited head", 1), ...raw.slice(1)]
						: [raw[0], assistantMessage("edited raw", 2)];
				if (change === "branch contraction") {
					nextRaw = raw.slice(1);
					nextIds = rawIds.slice(1);
				}
				if (change === "branch revert") {
					nextRaw = [raw[0]];
					nextIds = ["head"];
				}
				if (change === "model switch") switched = true;
				if (change === "session clear") {
					clearContextHandlerSession(sessionId);
					dropSlot(sessionId);
				}
				if (change === "other session") {
					activeSessionId = `${sessionId}-different`;
					sessions.add(activeSessionId);
				}
				if (change.includes("restart")) clearContextHandlerSession(sessionId);
				if (change.includes("persistence failure")) {
					const omission = spyOn(
						reasoningStorage,
						"addMergedReasoningStrippedIds",
					).mockReturnValue(false);
					try {
						await expect(
							pass(
								[...structuredClone(nextRaw), userMessage("new turn", 3)],
								[...nextIds, "new"],
							),
						).rejects.toMatchObject({ code: "PI_DEGRADED_PASS" });
						expect(
							omission.mock.calls.some((call) =>
								call[2].includes(
									reasoningStorage.thinkingBindingRecoveryFrozenId("tail-2"),
								),
							),
						).toBe(true);
					} finally {
						omission.mockRestore();
					}
					return;
				}
				const healthy = await pass(
					change.includes("active")
						? structuredClone(nextRaw)
						: [...structuredClone(nextRaw), userMessage("new turn", 3)],
					change.includes("active") ? nextIds : [...nextIds, "new"],
				);
				expect(JSON.stringify(healthy?.messages)).toContain(
					change === "content mismatch"
						? "edited raw"
						: change === "branch revert"
							? "new turn"
							: "served raw",
				);
				if (change === "branch revert")
					expect(JSON.stringify(healthy?.messages)).not.toContain("served raw");
				if (signed) {
					expect(JSON.stringify(busy?.messages)).toContain("signed-proof");
					expect(JSON.stringify(busy?.messages)).toContain(
						'"text":"unsigned before signature"',
					);
					expect(JSON.stringify(healthy?.messages)).not.toContain(
						"signed-proof",
					);
					expect(JSON.stringify(healthy?.messages)).not.toContain(
						"bound thought",
					);
				}
				if (change === "session clear" || change === "other session") {
					expect(textOf(healthy?.messages.at(-2))).toMatch(/^§\d+§ served raw/);
					expect(
						decisionLogInternals.getPendingPi(activeSessionId)
							?.lkgFrozenReleaseReason,
					).toBeUndefined();
				} else
					expect(
						decisionLogInternals.getPendingPi(sessionId)
							?.lkgFrozenReleaseReason,
					).toBe(
						change.includes("restart")
							? "lkg_restart_rebuild"
							: "lkg_recovery_input_rebuild",
					);
			} finally {
				if (locker.inTransaction) locker.exec("ROLLBACK");
				closeQuietly(locker);
				closeQuietly(db);
			}
		});
	}

	it("admits first Pi turns during bounded background holds without a saved request", async () => {
		const dir = createTestTempDirFromPath(join(tmpdir(), "pi-bounded-writer-"));
		tempDirs.push(dir);
		const path = join(dir, "context.db");
		const db = createTestDb(path);
		let refused = 0;
		try {
			for (let trial = 0; trial < 3; trial++) {
				const sessionId = `pi-bounded-${trial}`;
				sessions.add(sessionId);
				updateSessionMeta(db, sessionId, { piStableIdScheme: 1 });
				db.exec("PRAGMA busy_timeout=5000");
				const host = contextHost();
				const handler = handlerFor(db, host);
				// A separate process can release the lock while the main thread waits
				// synchronously in SQLite. A timer on this thread could not do that.
				// The holder needs its own busy timeout: its COMMIT can meet a
				// concurrent reader from the handler, and without one it would die
				// with SQLITE_BUSY instead of releasing the lock as the scenario needs.
				// Hold a real cross-process lock until the foreground request encounters it,
				// then require that request to succeed without replaying previously served bytes.
				const writer = spawn(
					process.execPath,
					[
						"-e",
						`import { Database } from 'bun:sqlite';
					const db = new Database(${JSON.stringify(path)});
					db.exec('PRAGMA busy_timeout=5000');
					db.exec('BEGIN IMMEDIATE'); console.log('locked');
					if ((await Bun.stdin.text()) !== 'RELEASE\\n') throw new Error('missing release signal');
					db.exec('COMMIT'); db.close(); console.log('committed');`,
					],
					{ stdio: ["pipe", "pipe", "pipe"], windowsHide: true },
				);
				const locked = Promise.withResolvers<void>();
				let stdout = "";
				let stderr = "";
				writer.stdout.on("data", (chunk) => {
					stdout += chunk.toString();
					if (stdout.split("\n").includes("locked")) locked.resolve();
				});
				writer.stderr.on("data", (chunk) => {
					stderr += chunk.toString();
				});
				const exited = new Promise<{ code: number | null; error?: Error }>(
					(resolve) => {
						writer.once("error", (error) => resolve({ code: null, error }));
						writer.once("close", (code) => resolve({ code }));
					},
				);
				const exec = db.exec.bind(db);
				let collided = false;
				const admission = spyOn(db, "exec").mockImplementation((sql) => {
					try {
						return exec(sql);
					} catch (error) {
						if (sql === "BEGIN IMMEDIATE" && !collided) {
							collided = true;
							writer.stdin.end("RELEASE\n");
						}
						throw error;
					}
				});
				try {
					await Promise.race([
						locked.promise,
						exited.then(({ code, error }) => {
							throw new Error(
								`writer exited before locked (${code}): ${error ?? ""}\n${stderr}`,
							);
						}),
					]);
					const raw = [userMessage(`first turn ${trial}`, 1)];
					const ctx = fakeContext(sessionId, dir, ["entry-1"], raw);
					await host.emit(handler as never, raw, ctx);
					expect(collided).toBe(true);
					if (host.controller.signal.aborted) refused++;
					// Saving the last-known-good request is queued on the event loop. Finish
					// that write before another child starts a transaction on this database.
					await nextImmediate();
				} finally {
					admission.mockRestore();
					if (!writer.stdin.writableEnded) writer.stdin.end("RELEASE\n");
					const { code, error } = await exited;
					expect(code, `writer exit ${code}: ${error ?? ""}\n${stderr}`).toBe(
						0,
					);
					expect(stdout.split("\n")).toContain("committed");
				}
			}
			expect(refused).toBe(0);
		} finally {
			closeQuietly(db);
		}
	});

	for (const emergency of [true, false]) {
		it(`installed host ${emergency ? "aborts emergency refusals" : "aborts ordinary failures even when raw messages fit"}`, async () => {
			const db = createTestDb();
			const sessionId = `pi-failure-${emergency}`;
			sessions.add(sessionId);
			try {
				const fake = createFakePi();
				const host = contextHost();
				Object.assign(fake.pi, host.api);
				registerPiContextHandler(fake.pi as never, {
					db,
					resolveForProject: () => {
						throw emergency
							? new EmergencyFailClosedError("emergency refusal")
							: new Error("ordinary transform defect");
					},
				});
				const raw = [userMessage("word ".repeat(170000), 1)];
				const ctx = fakeContext(sessionId, process.cwd(), ["entry-1"], raw);
				Object.assign(ctx, {
					model: {
						provider: "openai-codex",
						id: "gpt-5.6-sol",
						contextWindow: 272000,
						maxTokens: 68000,
					},
					// The host reports the same window as the model, so the raw
					// messages (about 170K tokens) fit its 204K usable limit, while
					// their serialized bytes divided by four (the byte proxy the
					// storage-busy fallback uses) do not. Raw messages whose tokens
					// are over the limit are refused instead; that case is in
					// context-handler-degraded-pass.test.ts.
					getContextUsage: () => ({
						tokens: 0,
						percent: 0,
						contextWindow: 272000,
					}),
				});
				const served = await host.emit(
					fake.handlers.get("context") as never,
					raw,
					ctx,
				);
				host.assertRefused(
					served,
					raw,
					emergency
						? undefined
						: "Magic Context could not safely prepare this turn [MC-S06] (context-handler-failed: ordinary transform defect). This request was not sent.",
				);
			} finally {
				closeQuietly(db);
			}
		});
	}

	for (const mode of ["handler", "host"]) {
		for (const count of [2812, 300]) {
			it(`fit-guards ${count} raw messages after snapshot, boundary contraction, and SQLITE_BUSY (${mode})`, async () => {
				const dir = createTestTempDirFromPath(join(tmpdir(), "pi-lkg-fit-"));
				tempDirs.push(dir);
				const dbPath = join(dir, "context.db");
				const db = createTestDb(dbPath);
				const sessionId = `pi-lkg-fit-${count}`;
				sessions.add(sessionId);
				const locker = new Database(dbPath);
				const logLines: string[] = [];
				const restoreLog =
					contextHandlerInternals.setLkgRecoveryLogObserverForTests((line) =>
						logLines.push(line),
					);
				try {
					updateSessionMeta(db, sessionId, { piStableIdScheme: 1 });
					const host = contextHost();
					const handler = handlerFor(db, mode === "host" ? host : undefined);
					const head = Array.from({ length: 268 }, (_, i) =>
						userMessage(`covered ${i}`, i),
					);
					const raw = Array.from({ length: count }, (_, i) =>
						userMessage("x".repeat(1850), i + 268),
					);
					const ids = Array.from(
						{ length: count },
						(_, i) => `entry-${i + 268}`,
					);
					const firstRaw = [...head, ...raw.slice(0, 1)];
					const firstCtx = fakeContext(
						sessionId,
						process.cwd(),
						[...head.map((_, i) => `entry-${i}`), "entry-268"],
						firstRaw as never,
					);
					const model = {
						provider: "openai-codex",
						id: "gpt-5.6-sol",
						contextWindow: 272000,
						maxTokens: 68000,
					};
					Object.assign(firstCtx, { model });
					const firstServed = await handler(
						{ messages: firstRaw as never[] },
						firstCtx as never,
					);
					expect(firstServed).toBeDefined();
					if (!firstServed) throw new Error("Expected an applied capture pass");

					await nextImmediate();
					appendCompartments(db, sessionId, [
						{
							sequence: 0,
							startMessage: 1,
							endMessage: 268,
							startMessageId: "entry-0",
							endMessageId: "entry-267",
							title: "Published head",
							content: "Covered history",
							p1: "Covered history",
						},
					]);
					// Publication removes only the covered head; replay retains the captured
					// surviving entry and appends untouched new entries.
					db.exec("PRAGMA busy_timeout=0");
					locker.exec("BEGIN IMMEDIATE");
					const ctx = fakeContext(sessionId, process.cwd(), ids, raw as never);
					Object.assign(ctx, {
						model,
						getContextUsage: () => ({
							tokens: 184856,
							percent: 90.6,
							contextWindow: 272000,
						}),
					});
					const pristine = structuredClone(raw);
					const pass =
						mode === "host"
							? host.emit(handler as never, raw, ctx)
							: handler({ messages: raw as never[] }, ctx as never);
					// Requests without measured system and tool definitions are refused even when their byte proxy is small.
					if (mode === "host") host.assertRefused(await pass, pristine);
					else {
						await expect(pass).rejects.toMatchObject({
							name: "PiStorageBusyError",
							message: "Magic Context storage is busy; send your message again",
						});
					}

					expect(logLines).toContain(
						"raw_fallback_refused completeness=partial",
					);
					expect(logLines.join("\n")).not.toContain("LKG replay served");
				} finally {
					if (locker.inTransaction) locker.exec("ROLLBACK");
					restoreLog();
					closeQuietly(locker);
					closeQuietly(db);
				}
			});
		}
	}

	for (const tailBytes of [17, 1_700_000]) {
		it(`host fit-guards LKG replay with ${tailBytes}-byte appended tail`, async () => {
			const dir = createTestTempDirFromPath(join(tmpdir(), "pi-lkg-busy-"));
			tempDirs.push(dir);
			const dbPath = join(dir, "context.db");
			const db = createTestDb(dbPath);
			const sessionId = "pi-lkg-busy";
			const logLines: string[] = [];
			const restoreLog =
				contextHandlerInternals.setLkgRecoveryLogObserverForTests((message) =>
					logLines.push(message),
				);
			sessions.add(sessionId);
			try {
				updateSessionMeta(db, sessionId, { piStableIdScheme: 1 });
				const host = contextHost();
				const handler = handlerFor(db, host);
				const firstRaw = [userMessage("original prompt", 1)];
				const model = {
					provider: "openai-codex",
					id: "gpt-5.6-sol",
					contextWindow: 272000,
					maxTokens: 68000,
				};
				const firstCtx = fakeContext(
					sessionId,
					process.cwd(),
					["entry-u1"],
					firstRaw,
				);
				Object.assign(firstCtx, { model });
				const first = await handler(
					{ messages: firstRaw as never[] },
					firstCtx as never,
				);
				expect(first).toBeDefined();
				await nextImmediate();

				const secondRaw = [
					userMessage("original prompt", 1),
					assistantMessage(
						"word ".repeat(Math.ceil(tailBytes / 5)).slice(0, tailBytes),
						2,
					),
				];

				const locker = new Database(dbPath);
				try {
					db.exec("PRAGMA busy_timeout=0");
					locker.exec("PRAGMA busy_timeout=0");
					locker.exec("BEGIN IMMEDIATE");
					const ctx = fakeContext(
						sessionId,
						process.cwd(),
						["entry-u1", "entry-a1"],
						secondRaw,
					);
					Object.assign(ctx, {
						model,
						getContextUsage: () => ({
							tokens: 0,
							percent: 0,
							contextWindow: 272000,
						}),
					});
					const served = await host.emit(handler as never, secondRaw, ctx);

					host.assertRefused(served, secondRaw);
					expect(logLines).toContain(
						"raw_fallback_refused completeness=partial",
					);
					expect(getInMemorySlot(sessionId)).toBeDefined();
				} finally {
					locker.exec("ROLLBACK");
					closeQuietly(locker);
				}
			} finally {
				restoreLog();
				closeQuietly(db);
			}
		});
	}

	it("fails closed instead of serving LKG or raw when emergency recovery meets SQLITE_BUSY", async () => {
		const dir = createTestTempDirFromPath(
			join(tmpdir(), "pi-lkg-emergency-busy-"),
		);
		tempDirs.push(dir);
		const dbPath = join(dir, "context.db");
		const db = createTestDb(dbPath);
		const sessionId = "pi-lkg-emergency-busy";
		sessions.add(sessionId);
		const locker = new Database(dbPath);
		try {
			updateSessionMeta(db, sessionId, { piStableIdScheme: 1 });
			recordOverflowDetected(db, sessionId, 100_000, "anthropic/fable-5-1");
			const host = contextHost();
			const handler = handlerFor(db, host);
			db.exec("PRAGMA busy_timeout=0");
			locker.exec("PRAGMA busy_timeout=0");
			locker.exec("BEGIN IMMEDIATE");

			await expect(
				runPass(
					handler,
					sessionId,
					[userMessage("overflow retry", 1)],
					["entry-u1"],
				),
			).rejects.toBeInstanceOf(EmergencyFailClosedError);
			const raw = [userMessage("overflow retry", 1)];
			const served = await host.emit(
				handler as never,
				raw,
				fakeContext(sessionId, process.cwd(), ["entry-u1"], raw),
			);
			host.assertRefused(served, raw);
		} finally {
			if (locker.inTransaction) locker.exec("ROLLBACK");
			closeQuietly(locker);
			closeQuietly(db);
		}
	}, 40000);

	it("refuses divergent LKG and unmeasured raw fallback", async () => {
		const dir = createTestTempDirFromPath(join(tmpdir(), "pi-lkg-diverged-"));
		tempDirs.push(dir);
		const dbPath = join(dir, "context.db");
		const db = createTestDb(dbPath);
		const sessionId = "pi-lkg-diverged";
		sessions.add(sessionId);
		const logLines: string[] = [];
		const restoreLog =
			contextHandlerInternals.setLkgRecoveryLogObserverForTests((message) =>
				logLines.push(message),
			);
		try {
			updateSessionMeta(db, sessionId, { piStableIdScheme: 1 });
			const handler = handlerFor(db);
			const firstRaw = [userMessage("original prompt", 1)];
			expect(
				await runPass(handler, sessionId, firstRaw, ["entry-u1"]),
			).toBeDefined();
			await nextImmediate();

			const editedRaw = [userMessage("edited prompt", 1)];
			const locker = new Database(dbPath);
			try {
				db.exec("PRAGMA busy_timeout=0");
				locker.exec("PRAGMA busy_timeout=0");
				locker.exec("BEGIN IMMEDIATE");
				await expect(
					runPass(handler, sessionId, editedRaw, ["entry-u1-edited"]),
				).rejects.toMatchObject({ code: "PI_STORAGE_BUSY" });

				expect(logLines).toContain(
					"TRANSIENT STORAGE FAILURE SQLITE_BUSY: LKG unavailable (lkg_invalidated_reshape); refusing unreduced 1-message input",
				);
			} finally {
				locker.exec("ROLLBACK");
				closeQuietly(locker);
			}
		} finally {
			restoreLog();
			closeQuietly(db);
		}
	});

	it("logs the exact reason and raw count when a transient lock has no LKG", async () => {
		const dir = createTestTempDirFromPath(join(tmpdir(), "pi-lkg-miss-"));
		tempDirs.push(dir);
		const dbPath = join(dir, "context.db");
		const db = createTestDb(dbPath);
		const sessionId = "pi-lkg-miss";
		sessions.add(sessionId);
		const logLines: string[] = [];
		const restoreLog =
			contextHandlerInternals.setLkgRecoveryLogObserverForTests((message) =>
				logLines.push(message),
			);
		const locker = new Database(dbPath);
		try {
			updateSessionMeta(db, sessionId, { piStableIdScheme: 1 });
			const handler = handlerFor(db);
			db.exec("PRAGMA busy_timeout=0");
			locker.exec("PRAGMA busy_timeout=0");
			locker.exec("BEGIN IMMEDIATE");
			const replay = runPass(
				handler,
				sessionId,
				[
					userMessage("first locked pass", 1),
					assistantMessage("unserved locked tail", 2),
				],
				["entry-u1", "entry-a1"],
			);
			await expect(replay).rejects.toMatchObject({ code: "PI_STORAGE_BUSY" });

			expect(logLines).toContain(
				"TRANSIENT STORAGE FAILURE SQLITE_BUSY: LKG unavailable (lkg_miss); refusing unreduced 2-message input",
			);
		} finally {
			if (locker.inTransaction) locker.exec("ROLLBACK");
			closeQuietly(locker);
			restoreLog();
			closeQuietly(db);
		}
	});

	it("hydrates the durable LKG slot in a fresh handler after a simulated process restart", async () => {
		const dir = createTestTempDirFromPath(join(tmpdir(), "pi-lkg-restart-"));
		tempDirs.push(dir);
		const dbPath = join(dir, "context.db");
		const db = createTestDb(dbPath);
		const sessionId = "pi-lkg-restart";
		sessions.add(sessionId);
		try {
			updateSessionMeta(db, sessionId, { piStableIdScheme: 1 });
			const firstHandler = handlerFor(db);
			const firstRaw = [userMessage("persist this prefix", 1)];
			const first = await runPass(firstHandler, sessionId, firstRaw, [
				"entry-u1",
			]);
			expect(first).toBeDefined();
			await nextImmediate();
			expect(
				db
					.prepare("SELECT session_id FROM lkg_slots WHERE session_id = ?")
					.get(sessionId),
			).toBeDefined();

			clearContextHandlerSession(sessionId);
			resetLkgSlotsForTest();
			const restartedHandler = handlerFor(db);
			const secondRaw = [
				userMessage("persist this prefix", 1),
				assistantMessage("tail after restart", 2),
			];

			const locker = new Database(dbPath);
			try {
				db.exec("PRAGMA busy_timeout=0");
				locker.exec("PRAGMA busy_timeout=0");
				locker.exec("BEGIN IMMEDIATE");
				expect(getInMemorySlot(sessionId)).toBeUndefined();
				await expect(
					runPass(restartedHandler, sessionId, secondRaw, [
						"entry-u1",
						"entry-a1",
					]),
				).rejects.toMatchObject({ code: "PI_STORAGE_BUSY" });
				expect(getInMemorySlot(sessionId)?.jsonPrefix).toContain(
					"persist this prefix",
				);
				expect(getInMemorySlot(sessionId)?.jsonPrefix).not.toContain(
					"tail after restart",
				);
			} finally {
				locker.exec("ROLLBACK");
				closeQuietly(locker);
			}
		} finally {
			closeQuietly(db);
		}
	});

	it("reports deferred LKG capture as the lkgCapture timing stage", async () => {
		const db = createTestDb();
		const sessionId = "pi-lkg-capture-timing";
		const samples: Array<{ stage: string; elapsedMs: number; extra?: string }> =
			[];
		const restoreTiming = setPiTransformTimingObserver((sample) =>
			samples.push(sample),
		);
		sessions.add(sessionId);
		try {
			updateSessionMeta(db, sessionId, { piStableIdScheme: 1 });
			const handler = handlerFor(db);
			expect(
				await runPass(
					handler,
					sessionId,
					[userMessage("timed prompt", 1)],
					["entry-u1"],
				),
			).toBeDefined();
			await nextImmediate();

			const capture = samples.find((sample) => sample.stage === "lkgCapture");
			expect(capture?.elapsedMs).toBeGreaterThanOrEqual(0);
			expect(capture?.extra).toBe("reusedPrefix=0");
		} finally {
			restoreTiming();
			closeQuietly(db);
		}
	});

	it("refreshes LKG on every successful SOFT+ applied pass", async () => {
		const dir = createTestTempDirFromPath(join(tmpdir(), "pi-lkg-refresh-"));
		tempDirs.push(dir);
		const dbPath = join(dir, "context.db");
		const db = createTestDb(dbPath);
		const sessionId = "pi-lkg-refresh";
		sessions.add(sessionId);
		try {
			updateSessionMeta(db, sessionId, { piStableIdScheme: 1 });
			const handler = handlerFor(db);
			const firstRaw = [userMessage("prompt", 1)];
			expect(
				await runPass(handler, sessionId, firstRaw, ["entry-u1"]),
			).toBeDefined();
			await nextImmediate();

			const secondRaw = [
				userMessage("prompt", 1),
				assistantMessage("first tail", 2),
			];
			const second = await runPass(handler, sessionId, secondRaw, [
				"entry-u1",
				"entry-a1",
			]);
			expect(second).toBeDefined();
			await nextImmediate();

			const thirdRaw = [
				userMessage("prompt", 1),
				assistantMessage("first tail", 2),
				userMessage("raw newest tail", 3),
			];

			const locker = new Database(dbPath);
			try {
				db.exec("PRAGMA busy_timeout=0");
				locker.exec("PRAGMA busy_timeout=0");
				locker.exec("BEGIN IMMEDIATE");
				await expect(
					runPass(handler, sessionId, thirdRaw, [
						"entry-u1",
						"entry-a1",
						"entry-u2",
					]),
				).rejects.toMatchObject({ code: "PI_STORAGE_BUSY" });
				expect(getInMemorySlot(sessionId)?.jsonPrefix).toContain("first tail");
				expect(getInMemorySlot(sessionId)?.jsonPrefix).not.toContain(
					"raw newest tail",
				);
			} finally {
				locker.exec("ROLLBACK");
				closeQuietly(locker);
			}
		} finally {
			closeQuietly(db);
		}
	});
});
