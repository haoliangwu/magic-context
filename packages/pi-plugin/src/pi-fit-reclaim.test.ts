import { expect, it, spyOn } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import {
	getPendingOps,
	getTagsBySession,
	queuePendingOp,
	updateSessionMeta,
} from "@magic-context/core/features/magic-context/storage";
import {
	recordOverflowDetected,
	resetEmergencyRecoveryRegistryForTest,
} from "@magic-context/core/features/magic-context/storage-meta-persisted";
import {
	readReplayEnvelope,
	updateReplayDocument,
} from "@magic-context/core/features/magic-context/storage-replay-document";
import * as logger from "@magic-context/core/shared/logger";
import { createTestTempDir } from "@magic-context/core/shared/test-temp-dir";
import {
	clearContextHandlerSession,
	registerPiContextHandler,
} from "./context-handler";
import {
	clearPiUpperReclaimSession,
	piFitOverflowPossible,
	piUpperReclaimCursor,
	recordPiUpperEstimateReclaim,
	releasePiUpperEstimateReclaim,
	reservePiUpperEstimateReclaim,
	shouldReclaimPiUpperEstimate,
} from "./pi-fit-reclaim";
import * as lkg from "./pi-lkg";
import * as fit from "./pi-raw-fallback";
import { handlePiProviderFailure } from "./provider-error-recovery-pi";
import {
	createFakePi,
	createTestDb,
	fakeContext,
	userMessage,
} from "./test-utils.test";

it("upper-estimate reclaim is durable and rearms only for a changed head, capacity or overflow", () => {
	const db = createTestDb();
	const sessionId = "fit-reclaim-cursor";
	const cursor = (
		count = 1,
		modelKey = "mock/mock",
		contextWindow = 50000,
		head = "same head",
	) =>
		piUpperReclaimCursor({
			sessionId,
			modelKey,
			contextWindow,
			head: { cachedM0Bytes: Buffer.from(head) },
			messageCount: count,
			input: [userMessage(`ordinary append ${count}`, count)],
		});
	try {
		const first = cursor();
		if (!first) throw new Error("fixture cursor missing");
		expect(shouldReclaimPiUpperEstimate(db, first)).toBe(true);
		recordPiUpperEstimateReclaim(db, first);
		expect(shouldReclaimPiUpperEstimate(db, cursor())).toBe(false);
		clearPiUpperReclaimSession(sessionId);
		expect(shouldReclaimPiUpperEstimate(db, cursor())).toBe(false);
		expect(shouldReclaimPiUpperEstimate(db, cursor(2))).toBe(false);
		expect(
			shouldReclaimPiUpperEstimate(db, cursor(1, "mock/mock", 60000)),
		).toBe(true);
		expect(
			shouldReclaimPiUpperEstimate(
				db,
				cursor(1, "mock/mock", 50000, "rebuilt head"),
			),
		).toBe(true);
		expect(shouldReclaimPiUpperEstimate(db, cursor(1, "mock/other"))).toBe(
			true,
		);
		recordOverflowDetected(db, sessionId, undefined, "mock/mock");
		expect(shouldReclaimPiUpperEstimate(db, cursor())).toBe(true);
	} finally {
		clearPiUpperReclaimSession(sessionId);
		db.close();
	}
});

it("upper-only reservations compare-and-set before work and release only a failed owner's claim", () => {
	const { dir } = createTestTempDir("pi-fit-atomic-");
	const path = join(dir, "claims.db");
	const db = createTestDb(path);
	const other = createTestDb(path);
	const sessionId = "fit-atomic-claims";
	const cursor = piUpperReclaimCursor({
		sessionId,
		modelKey: "mock/mock",
		messageCount: 1,
		input: [userMessage("same", 1)],
	});
	if (!cursor) throw new Error("fixture cursor missing");
	try {
		updateReplayDocument(db, sessionId, (doc) => {
			doc.version = 2;
			doc.unrelated = { keep: "unchanged" };
			return true;
		});
		// Both contenders can observe absence, but only one may start work.
		expect(shouldReclaimPiUpperEstimate(db, cursor)).toBe(true);
		expect(shouldReclaimPiUpperEstimate(other, cursor)).toBe(true);
		const first = reservePiUpperEstimateReclaim(db, cursor);
		expect(typeof first).toBe("string");
		if (!first) throw new Error("first reservation missing");
		expect(reservePiUpperEstimateReclaim(other, cursor)).toBeUndefined();
		expect(shouldReclaimPiUpperEstimate(other, cursor)).toBe(false);
		releasePiUpperEstimateReclaim(other, cursor, "not the owner");
		expect(shouldReclaimPiUpperEstimate(other, cursor)).toBe(false);
		releasePiUpperEstimateReclaim(db, cursor, first);
		const retry = reservePiUpperEstimateReclaim(other, cursor);
		expect(typeof retry).toBe("string");
		if (!retry) throw new Error("retry reservation missing");
		recordPiUpperEstimateReclaim(db, cursor, first);
		expect(
			readReplayEnvelope(db, sessionId).piUpperEstimateReclaim,
		).toHaveProperty("reservation", retry);
		recordPiUpperEstimateReclaim(other, cursor, retry);
		clearPiUpperReclaimSession(sessionId);
		expect(reservePiUpperEstimateReclaim(db, cursor)).toBeUndefined();
		expect(
			readReplayEnvelope(db, sessionId).piUpperEstimateReclaim,
		).not.toHaveProperty("reservation");
		expect(readReplayEnvelope(db, sessionId).unrelated).toEqual({
			keep: "unchanged",
		});
	} finally {
		clearPiUpperReclaimSession(sessionId);
		other.close();
		db.close();
	}
});

it("failed upper-reclaim cleanup never waits for a competing writer", () => {
	const { dir } = createTestTempDir("pi-fit-cleanup-");
	const path = join(dir, "claims.db");
	const db = createTestDb(path);
	const other = createTestDb(path);
	const sessionId = "fit-cleanup-busy";
	const cursor = piUpperReclaimCursor({
		sessionId,
		modelKey: "mock/mock",
		messageCount: 1,
		input: [userMessage("same", 1)],
	});
	if (!cursor) throw new Error("fixture cursor missing");
	try {
		const reservation = reservePiUpperEstimateReclaim(db, cursor);
		if (!reservation) throw new Error("reservation missing");
		db.exec("PRAGMA busy_timeout=5000");
		other.exec("BEGIN IMMEDIATE");
		const start = performance.now();
		expect(() =>
			releasePiUpperEstimateReclaim(db, cursor, reservation),
		).toThrow(/locked|busy/i);
		expect(performance.now() - start).toBeLessThan(300);
		expect(other.inTransaction).toBe(true);
		other.exec("ROLLBACK");
		expect(
			readReplayEnvelope(db, sessionId).piUpperEstimateReclaim,
		).toHaveProperty("reservation", reservation);
		releasePiUpperEstimateReclaim(db, cursor, reservation);
		expect(
			readReplayEnvelope(db, sessionId).piUpperEstimateReclaim,
		).toBeUndefined();
	} finally {
		if (other.inTransaction) other.exec("ROLLBACK");
		clearPiUpperReclaimSession(sessionId);
		other.close();
		db.close();
		rmSync(dir, { recursive: true, force: true });
	}
}, 10000);

it("upper-only claim has one winner across simultaneous processes", async () => {
	const { dir } = createTestTempDir("pi-fit-process-cas-");
	const path = join(dir, "claims.db");
	const db = createTestDb(path);
	const script = `
		import { Database } from "@magic-context/core/shared/sqlite";
		import { piUpperReclaimCursor, reservePiUpperEstimateReclaim } from "./src/pi-fit-reclaim";
		if (!process.env.MAGIC_CONTEXT_TEST_DATA_DIR) throw new Error("isolated test environment required");
		const db = new Database(${JSON.stringify(path)});
		db.exec("PRAGMA busy_timeout = 5000");
		const cursor = piUpperReclaimCursor({ sessionId: "process-cas", modelKey: "mock/mock", messageCount: 1, input: [] });
		console.log("READY");
		await new Promise((resolve) => { process.stdin.once("end", resolve); process.stdin.resume(); });
		console.log("CLAIM:" + Boolean(reservePiUpperEstimateReclaim(db, cursor)));
		db.close();
	`;
	// Children inherit the test preload's isolated paths; its lifecycle hooks
	// belong only to the parent test runner, not these plain Bun processes.
	const children = Array.from({ length: 2 }, () =>
		Bun.spawn([process.execPath, "--eval", script], {
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
			env: { ...process.env, OPENCODE_DB: undefined },
			windowsHide: true,
		}),
	);
	try {
		const readers = children.map((child) => child.stdout.getReader());
		for (const [index, reader] of readers.entries()) {
			const first = await reader.read();
			if (first.done)
				throw new Error(await new Response(children[index].stderr).text());
			expect(new TextDecoder().decode(first.value)).toContain("READY");
		}
		for (const child of children) child.stdin.end();
		const outcomes = await Promise.all(
			readers.map(async (reader, index) => {
				let text = "";
				for (;;) {
					const chunk = await reader.read();
					if (chunk.done) break;
					text += new TextDecoder().decode(chunk.value);
				}
				const exit = await children[index].exited;
				const stderr = await new Response(children[index].stderr).text();
				if (exit !== 0) throw new Error(stderr);
				expect(exit).toBe(0);
				expect(stderr).toBe("");
				return text.trim();
			}),
		);
		expect(outcomes.sort()).toEqual(["CLAIM:false", "CLAIM:true"]);
	} finally {
		for (const child of children) child.kill();
		db.close();
	}
});

it("three unchanged metadata over-count passes force at most one rebuild and keep served bytes", async () => {
	const db = createTestDb();
	const sessionId = "fit-reclaim-once";
	const fake = createFakePi();
	Object.assign(fake.pi, { getAllTools: () => [] });
	const lines: string[] = [];
	const log = spyOn(logger, "sessionLog").mockImplementation(
		(_id, ...parts) => {
			lines.push(parts.join(" "));
		},
	);
	const source = [
		{
			role: "custom",
			customType: "notice",
			timestamp: 1,
			content: [
				{ type: "text", text: "small visible notice" },
				{ type: "extension-metadata", details: "x".repeat(1000000) },
			],
		},
		userMessage("continue", 2),
	];
	const install = () => {
		registerPiContextHandler(fake.pi as never, {
			db,
			protectedTags: 0,
			injection: {
				injectionBudgetTokens: 10000,
				injectDocs: false,
				memoryEnabled: false,
			},
		});
		return fake.handlers.get("context") as (
			event: { messages: never[] },
			ctx: never,
		) => Promise<{ messages: unknown[] }>;
	};
	let handler = install();
	const pass = async () => {
		const input = structuredClone(source);
		const base = fakeContext(
			sessionId,
			process.cwd(),
			["notice", "user"],
			input as never[],
		);
		const result = await handler({ messages: input as never[] }, {
			...base,
			hasUI: false,
			getSystemPrompt: () => "You are helpful.",
			model: { provider: "mock", id: "mock", contextWindow: 50000 },
			getContextUsage: () => ({
				tokens: 0,
				percent: 0,
				contextWindow: 50000,
			}),
		} as never);
		updateSessionMeta(db, sessionId, {
			lastResponseTime: Date.now(),
			lastInputTokens: 0,
			lastContextPercentage: 0,
		});
		return JSON.stringify(result.messages);
	};
	try {
		const first = await pass();
		expect(await pass()).toBe(first);
		expect(await pass()).toBe(first);
		expect(
			lines.filter((line) =>
				line.includes("upper-estimate-pressure; attempting emergency reclaim"),
			),
		).toHaveLength(1);
		clearContextHandlerSession(sessionId);
		handler = install();
		expect(await pass()).toBe(first);
		expect(
			lines.filter((line) =>
				line.includes("upper-estimate-pressure; attempting emergency reclaim"),
			),
		).toHaveLength(1);
	} finally {
		log.mockRestore();
		clearContextHandlerSession(sessionId);
		db.close();
	}
});

it("ordinary native defer does not clone the full input or enter the final fit block", async () => {
	const db = createTestDb();
	const sessionId = "fit-defer-hot-path";
	const fake = createFakePi();
	Object.assign(fake.pi, { getAllTools: () => [] });
	registerPiContextHandler(fake.pi as never, {
		db,
		protectedTags: 0,
		injection: {
			injectionBudgetTokens: 10000,
			injectDocs: false,
			memoryEnabled: false,
		},
	});
	const handler = fake.handlers.get("context") as (
		event: { messages: never[] },
		ctx: never,
	) => Promise<unknown>;
	const source = Array.from({ length: 100 }, (_, index) =>
		userMessage(`small ${index}`, index),
	);
	const prepare = () => {
		const input = structuredClone(source);
		return {
			event: { messages: input as never[] },
			ctx: {
				...fakeContext(
					sessionId,
					process.cwd(),
					source.map((_, i) => `entry-${i}`),
					input,
				),
				model: {
					provider: "anthropic",
					id: "claude-fable-5-1",
					contextWindow: 272000,
				},
				getSystemPrompt: () => "You are helpful.",
				getContextUsage: () => ({
					tokens: 1000,
					percent: 0.4,
					contextWindow: 272000,
				}),
			},
		};
	};
	try {
		const warm = prepare();
		await handler(warm.event, warm.ctx as never);
		updateSessionMeta(db, sessionId, {
			lastResponseTime: Date.now(),
			lastInputTokens: 1000,
			lastContextPercentage: 0.4,
		});
		const { event, ctx } = prepare();
		let fullClones = 0;
		const originalClone = globalThis.structuredClone;
		const clones = spyOn(globalThis, "structuredClone").mockImplementation(((
			value: unknown,
			options?: StructuredSerializeOptions,
		) => {
			if (Array.isArray(value) && value.length >= source.length) fullClones++;
			return originalClone(value, options);
		}) as typeof structuredClone);
		const estimate = spyOn(fit, "estimatePiOutgoingInputTokens");
		const restore = spyOn(lkg, "restorePiLkgInputForFit");
		let claimIo = 0;
		const prepareStatement = db.prepare.bind(db);
		const statements = spyOn(db, "prepare").mockImplementation(
			(sql: string) => {
				const statement = prepareStatement(sql);
				if (!new Error().stack?.includes("/pi-fit-reclaim.ts:"))
					return statement;
				return new Proxy(statement, {
					get(target, property) {
						const value = Reflect.get(target, property, target);
						if (typeof value !== "function") return value;
						return (...args: unknown[]) => {
							if (["get", "all", "run", "values"].includes(String(property)))
								claimIo++;
							return Reflect.apply(value, target, args);
						};
					},
				});
			},
		);
		try {
			await handler(event, ctx as never);
			expect(claimIo).toBe(0);
			expect(fullClones).toBe(0);
			expect(estimate).not.toHaveBeenCalled();
			expect(restore).not.toHaveBeenCalled();
			const cursor = piUpperReclaimCursor({
				sessionId,
				modelKey: "mock/mock",
				messageCount: 1,
				input: source,
			});
			if (!cursor) throw new Error("fixture cursor missing");
			expect(reservePiUpperEstimateReclaim(db, cursor)).toBeDefined();
			expect(claimIo).toBeGreaterThan(0);
			console.log(
				`upper-only claim I/O: ordinary defer=0; reservation=${claimIo}`,
			);
			const original = getTagsBySession(db, sessionId).find(
				(tag) => tag.messageId === "entry-0:p0",
			);
			if (!original) throw new Error("initial tag missing");
			queuePendingOp(db, sessionId, original.tagNumber, "drop");
			const largeTail = [
				...source,
				{
					role: "custom",
					customType: "notice",
					timestamp: 101,
					content: [
						{ type: "text", text: "small" },
						{ type: "extension", details: "x".repeat(1000000) },
					],
				},
			];
			const next = prepare();
			claimIo = 0;
			await handler({ messages: structuredClone(largeTail) as never[] }, {
				...next.ctx,
				...fakeContext(
					sessionId,
					process.cwd(),
					largeTail.map((_, i) => `entry-${i}`),
					largeTail as never[],
				),
			} as never);
			expect(claimIo).toBe(0);
			expect(
				getTagsBySession(db, sessionId).find(
					(tag) => tag.tagNumber === original.tagNumber,
				)?.status,
			).toBe(original.status);
			expect(getPendingOps(db, sessionId)).toHaveLength(1);
		} finally {
			statements.mockRestore();
			restore.mockRestore();
			estimate.mockRestore();
			clones.mockRestore();
		}
		expect(
			piFitOverflowPossible({
				hasUI: false,
				inputTokens: 1000,
				recoveryArmed: false,
				forceMaterialization: false,
				imported: false,
				coldInjection: false,
				cacheBusting: false,
				sessionId,
			}),
		).toBe(false);
	} finally {
		clearContextHandlerSession(sessionId);
		db.close();
	}
});

it("a locally refused native request remains fit-checked on an unmeasured retry", async () => {
	const db = createTestDb();
	const sessionId = "fit-refusal-retry";
	const fake = createFakePi();
	Object.assign(fake.pi, { getAllTools: () => [] });
	registerPiContextHandler(fake.pi as never, {
		db,
		injection: {
			injectionBudgetTokens: 10000,
			injectDocs: false,
			memoryEnabled: false,
		},
	});
	const handler = fake.handlers.get("context") as (
		event: { messages: never[] },
		ctx: never,
	) => Promise<unknown>;
	try {
		for (let attempt = 0; attempt < 3; attempt++) {
			const input = [
				userMessage(
					[
						{ type: "text", text: "word ".repeat(100000) },
						{ type: "extension-metadata", details: "uncertain sibling" },
					] as never,
					1,
				),
				userMessage(`attempt ${attempt}`, 2),
			];
			await expect(
				handler({ messages: input as never[] }, {
					...fakeContext(sessionId, process.cwd(), ["large", "latest"], input),
					getSystemPrompt: () => "You are helpful.",
					model: { provider: "mock", id: "mock", contextWindow: 50000 },
				} as never),
			).rejects.toThrow("this turn was not sent");
		}
	} finally {
		clearContextHandlerSession(sessionId);
		db.close();
	}
});

it("provider overflow clears upper-only suppression across a process restart", () => {
	const db = createTestDb();
	const sessionId = "fit-provider-error-restart";
	const make = () =>
		piUpperReclaimCursor({
			sessionId,
			modelKey: "mock/mock",
			messageCount: 1,
			input: [userMessage("same content", 1)],
		});
	try {
		const cursor = make();
		if (!cursor) throw new Error("fixture cursor missing");
		recordPiUpperEstimateReclaim(db, cursor);
		expect(
			handlePiProviderFailure({
				db,
				sessionId,
				message: {
					role: "assistant",
					provider: "mock",
					model: "mock",
					errorMessage: "Your input exceeds the context window of this model.",
				},
			}).kind,
		).toBe("overflow");
		clearPiUpperReclaimSession(sessionId);
		resetEmergencyRecoveryRegistryForTest();
		expect(shouldReclaimPiUpperEstimate(db, make())).toBe(true);
	} finally {
		clearPiUpperReclaimSession(sessionId);
		db.close();
	}
});

it("lazy fit input requires every unchanged canonical entry and rejects extension-only frames", () => {
	const db = createTestDb();
	const sessionId = "fit-canonical-restore";
	const source = [
		userMessage("original first", 1),
		userMessage("original second", 2),
	];
	const entries = source.map((message, index) => ({
		type: "message",
		id: `m${index}`,
		message,
	}));
	const coordinator = lkg.createPiLkgCoordinator(db);
	const begin = (messages: unknown[], ids: (string | undefined)[]) =>
		coordinator.beginPass({
			sessionId,
			messages,
			entryIds: ids,
			modelKey: "mock/mock",
			providerKey: "mock",
			apiKey: "anthropic-messages",
		});
	try {
		const snapshot = begin(source, ["m0", "m1"]);
		const restored = lkg.restorePiLkgInputForFit(snapshot, entries);
		expect(restored).toEqual(source);
		expect(restored?.[0]).not.toBe(source[0]);
		expect(
			lkg.restorePiLkgInputForFit(snapshot, [...entries, entries[0]]),
		).toBeUndefined();
		const extended = begin(
			[...source, userMessage("extension frame", 3)],
			["m0", "m1", undefined],
		);
		expect(lkg.restorePiLkgInputForFit(extended, entries)).toBeUndefined();
		let getterReads = 0;
		const accessor = {
			...source[0],
			get content() {
				getterReads++;
				return [];
			},
		};
		expect(
			lkg.restorePiLkgInputForFit(snapshot, [
				{ ...entries[0], message: accessor },
				entries[1],
			]),
		).toBeUndefined();
		expect(getterReads).toBe(0);
		source[0].content = [{ type: "text", text: "edited after snapshot" }];
		expect(lkg.restorePiLkgInputForFit(snapshot, entries)).toBeUndefined();
	} finally {
		clearContextHandlerSession(sessionId);
		db.close();
	}
});
