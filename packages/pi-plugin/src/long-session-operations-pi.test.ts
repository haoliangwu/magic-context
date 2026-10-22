import { expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import { rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	getTagsBySession,
	queuePendingOp,
} from "@magic-context/core/features/magic-context/storage";
import { getNewestToolTagNumbers } from "@magic-context/core/features/magic-context/storage-tags";
import { applyPendingOperations } from "@magic-context/core/hooks/magic-context/apply-operations";
import { resetLkgSlotsForTest } from "@magic-context/core/hooks/magic-context/lkg-slot";
import { createTestTempDirFromPath } from "../../plugin/src/shared/test-temp-dir";
import {
	__test,
	clearContextHandlerSession,
	registerPiContextHandler,
	signalPiPendingMaterialization,
} from "./context-handler";
import * as snapshots from "./tag-snapshot-pi";
import {
	assistantMessage,
	assistantToolCall,
	createFakePi,
	createTestDb,
	fakeContext,
	toolResultMessage,
	userMessage,
} from "./test-utils.test";

test("pending drops use one tag update each and one batch commit before wire mutation", () => {
	const db = createTestDb();
	try {
		const insert = db.prepare(
			"INSERT INTO tags(session_id,tag_number,message_id,type,status,byte_size,drop_mode) VALUES('s',?,?,'tool','active',100,'skeleton_real')",
		);
		insert.run(1, "call-1");
		insert.run(2, "call-2");
		queuePendingOp(db, "s", 1, "drop");
		queuePendingOp(db, "s", 2, "drop");
		let updates = 0,
			commits = 0,
			mutations = 0;
		const prepare = db.prepare.bind(db);
		const statements = spyOn(db, "prepare").mockImplementation(
			(sql: string) => {
				const statement = prepare(sql);
				if (/^UPDATE tags SET/.test(sql)) {
					const run = statement.run.bind(statement);
					statement.run = ((...args: unknown[]) => {
						updates++;
						return run(...args);
					}) as typeof statement.run;
				}
				return statement;
			},
		);
		const exec = db.exec.bind(db);
		const transactions = spyOn(db, "exec").mockImplementation((sql: string) => {
			const result = exec(sql);
			if (sql === "COMMIT") commits++;
			return result;
		});
		const targets = new Map(
			[1, 2].map((n) => [
				n,
				{
					setContent: () => false,
					prepareDrop: () => true,
					getInputStringBytes: () => 10_000,
					drop: () => {
						expect(db.inTransaction).toBe(false);
						expect(commits).toBe(1);
						expect(
							getTagsBySession(db, "s").find((t) => t.tagNumber === n)
								?.dropMode,
						).toBe("full");
						mutations++;
						return "removed" as const;
					},
				},
			]),
		);
		try {
			expect(applyPendingOperations("s", db, targets, new Set())).toBe(true);
			expect(updates).toBe(2);
			expect(commits).toBe(1);
			expect(mutations).toBe(2);
		} finally {
			statements.mockRestore();
			transactions.mockRestore();
		}
	} finally {
		db.close();
	}
});

test("newest tool window uses the chronological index without sorting session history", () => {
	const db = createTestDb();
	try {
		const insert = db.prepare(
			"INSERT INTO tags(session_id,tag_number,message_id,type,status,byte_size) VALUES('s',?,?,'tool','active',100)",
		);
		for (let n = 1; n <= 100; n++) insert.run(n, `call-${n}`);
		const prepare = db.prepare.bind(db);
		let plan = "";
		const statements = spyOn(db, "prepare").mockImplementation(
			(sql: string) => {
				if (sql.includes("ORDER BY tag_number DESC"))
					plan = JSON.stringify(
						prepare(`EXPLAIN QUERY PLAN ${sql}`).all("s", 20),
					);
				return prepare(sql);
			},
		);
		try {
			expect(getNewestToolTagNumbers(db, "s", 20)).toEqual(
				Array.from({ length: 20 }, (_, i) => 100 - i),
			);
			expect(plan).toContain("sqlite_autoindex_tags_");
			expect(plan).not.toContain("TEMP B-TREE");
		} finally {
			statements.mockRestore();
		}
	} finally {
		db.close();
	}
});

const scaleTest = process.env.PI_LONG_SCALE_TEST === "1" ? test : test.skip;
scaleTest(
	"long-session tool window stays below 20ms at 200k historical tags",
	() => {
		const db = createTestDb();
		try {
			const insert = db.prepare(
				"INSERT INTO tags(session_id,tag_number,message_id,type,status,byte_size) VALUES('s',?,?,'tool','compacted',4000)",
			);
			db.transaction(() => {
				for (let n = 1; n <= 200_000; n++)
					insert.run(n, `historical-call-${n}`);
			}).immediate();
			const start = performance.now();
			expect(getNewestToolTagNumbers(db, "s", 20)).toEqual(
				Array.from({ length: 20 }, (_, i) => 200_000 - i),
			);
			const elapsed = performance.now() - start;
			console.log(
				`200k-tag newest-tool window: ${elapsed.toFixed(3)}ms (budget 20ms)`,
			);
			expect(elapsed).toBeLessThan(20);
		} finally {
			db.close();
		}
	},
	30_000,
);

test("randomized Pi differential records 320 passes with restart and LKG replay", async () => {
	const warmOnly = process.env.PI_LONG_WARM_ONLY === "1";
	const directory = createTestTempDirFromPath(join(tmpdir(), "pi-long-diff-"));
	const path = join(directory, "context.db");
	const sessionId = "pi-long-differential";
	let db = createTestDb(path);
	const install = () => {
		const fake = createFakePi();
		Object.assign(fake.pi, { getAllTools: () => [] });
		registerPiContextHandler(fake.pi as never, {
			db,
			protectedTags: 0,
			injection: {
				injectDocs: false,
				memoryEnabled: false,
				temporalAwareness: false,
			},
			scheduler: { executeThresholdPercentage: 80 },
		});
		const handler = fake.handlers.get("context");
		if (!handler) throw new Error("Missing context handler");
		return handler;
	};
	let handler = install();
	const messages = [userMessage("Review the synthetic implementation.", 1)];
	const records: {
		wire: string;
		system: string;
		tags: string;
		pending: string;
		event: string;
		gates: unknown[];
	}[] = [];
	let gates: unknown[] = [];
	const restoreGates = __test.setMutationGateObserverForTests((gate) =>
		gates.push(gate),
	);
	const restoreResults = __test.setPipelineResultObserverForTests(
		(_session, result) => gates.push(result),
	);
	let coldStartsDuringRecords = 0;
	let seed = 0x6f1a083;
	const random = (n: number) => {
		seed ^= seed << 13;
		seed ^= seed >>> 17;
		seed ^= seed << 5;
		return (seed >>> 0) % n;
	};
	const sha = (value: unknown) =>
		createHash("sha256").update(JSON.stringify(value)).digest("hex");
	let replays = 0,
		restarts = 0,
		drops = 0;
	let replayLogs = 0;
	const restoreObserver = __test.setLkgRecoveryLogObserverForTests((line) => {
		if (line.includes("LKG replay served")) replayLogs++;
	});
	try {
		if (warmOnly) {
			const ctx = Object.assign(
				fakeContext(
					sessionId,
					"/synthetic/pi-long-differential",
					["entry-0"],
					messages,
				),
				{
					getSystemPrompt: () => "Synthetic system prompt.",
					model: {
						provider: "anthropic",
						id: "claude-sonnet-4-5",
						contextWindow: 200_000,
					},
					getContextUsage: () => ({
						tokens: 1000,
						percent: 1,
						contextWindow: 200_000,
					}),
				},
			);
			expect(
				(
					await handler(
						{ messages: structuredClone(messages) } as never,
						ctx as never,
					)
				)?.messages,
			).toBeDefined();
			// This same driver also runs against 0.49.12, which has no worker hook.
			// The call above primes this connection before recording; a worker
			// during the next 320 passes would invalidate the warm-only comparison.
			const installWorker = (
				snapshots as unknown as {
					__setPiTagSnapshotWorkerForTests?: (
						connection: typeof db,
						factory: () => never,
					) => void;
				}
			).__setPiTagSnapshotWorkerForTests;
			installWorker?.(db, () => {
				coldStartsDuringRecords++;
				throw new Error("warm differential started a cold worker");
			});
		}
		for (let pass = 0; pass < 320; pass++) {
			gates = [];
			let event = "ordinary";
			if (!warmOnly && pass > 0 && pass % 73 === 0) {
				await new Promise<void>((resolve) => setImmediate(resolve));
				clearContextHandlerSession(sessionId);
				resetLkgSlotsForTest();
				db.close();
				db = createTestDb(path);
				handler = install();
				restarts++;
				event = "restart";
			}
			const append = random(5) === 0;
			if (append) {
				const n = messages.length;
				messages.push(
					assistantToolCall(
						`call-${n}`,
						"read",
						{ path: `file-${random(7)}.ts` },
						n + 1,
					),
					toolResultMessage(
						`call-${n}`,
						`output ${"body ".repeat(20 + random(100))}`,
						n + 2,
					),
					assistantMessage(`Result ${n}`, n + 3),
					userMessage(`Continue ${n}`, n + 4),
				);
			}
			const active = getTagsBySession(db, sessionId).filter(
				(t) => t.status === "active",
			);
			if (random(4) === 0 && active.length) {
				const selected = active[random(active.length)];
				if (!selected) throw new Error("Missing selected tag");
				queuePendingOp(db, sessionId, selected.tagNumber, "drop");
				signalPiPendingMaterialization(sessionId);
				drops++;
			}
			const replay = pass > 1 && pass % 29 === 0 && event !== "restart";
			const exec = db.exec.bind(db);
			let denied = 0;
			const busy = replay
				? spyOn(db, "exec").mockImplementation((sql: string) => {
						if (/^BEGIN IMMEDIATE/.test(sql)) {
							denied++;
							throw new Error("SQLITE_BUSY: synthetic admission denial");
						}
						return exec(sql);
					})
				: undefined;
			const raw = structuredClone(messages);
			const ids = raw.map((_, i) => `entry-${i}`);
			const ctx = fakeContext(
				sessionId,
				"/synthetic/pi-long-differential",
				ids,
				raw,
			);
			Object.assign(ctx, {
				getSystemPrompt: () => "Synthetic system prompt.",
				model: {
					provider: "anthropic",
					id: "claude-sonnet-4-5",
					contextWindow: 200_000,
				},
				getContextUsage: () => ({
					tokens: 1000,
					percent: 1,
					contextWindow: 200_000,
				}),
			});
			let result: { messages?: unknown[] } | undefined;
			try {
				result = (await handler(
					{ messages: raw } as never,
					ctx as never,
				)) as typeof result;
			} finally {
				busy?.mockRestore();
			}
			if (replay) {
				expect(denied).toBeGreaterThan(0);
				expect(result?.messages).toBeDefined();
				replays++;
				event = "LKG";
			}
			expect(result?.messages).toBeDefined();
			records.push({
				wire: JSON.stringify(result?.messages),
				system: ctx.getSystemPrompt(),
				tags: sha(
					db
						.prepare(
							"SELECT id,tag_number,message_id,type,status,drop_mode,tool_name,input_byte_size,byte_size,reasoning_byte_size,caveman_depth,tool_owner_message_id,entry_fingerprint,token_count,input_token_count,reasoning_token_count,harness FROM tags WHERE session_id = ? ORDER BY id",
						)
						.all(sessionId),
				),
				pending: sha(
					db
						.prepare(
							"SELECT tag_id,operation FROM pending_ops WHERE session_id = ? ORDER BY queued_at ASC, id ASC",
						)
						.all(sessionId),
				),
				event,
				gates,
			});
			await new Promise<void>((resolve) => setImmediate(resolve));
		}
		expect(restarts).toBe(warmOnly ? 0 : 4);
		expect(replays).toBe(11);
		expect(replayLogs).toBe(11);
		expect(drops).toBeGreaterThan(40);
		expect(coldStartsDuringRecords).toBe(0);
		if (process.env.PI_LONG_DIFFERENTIAL_OUTPUT)
			writeFileSync(
				process.env.PI_LONG_DIFFERENTIAL_OUTPUT,
				JSON.stringify(records),
			);
		console.log(
			`Pi differential: ${records.length} passes, ${restarts} connection restarts, ${replays} admission-denial recoveries, ${drops} queued drops`,
		);
	} finally {
		restoreGates();
		restoreResults();
		restoreObserver();
		clearContextHandlerSession(sessionId);
		resetLkgSlotsForTest();
		db.close();
		rmSync(directory, { recursive: true, force: true });
	}
}, 120_000);
