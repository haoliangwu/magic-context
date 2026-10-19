import { expect, it } from "bun:test";
import { join } from "node:path";
import {
	acquireCompartmentLease,
	releaseCompartmentLeaseBestEffort,
} from "@magic-context/core/features/magic-context/compartment-lease";
import {
	appendCompartments,
	getCompartments,
} from "@magic-context/core/features/magic-context/compartment-storage";
import {
	getOrCreateSessionMeta,
	getPendingPiCompactionMarkerState,
	setPendingPiCompactionMarkerState,
} from "@magic-context/core/features/magic-context/storage";
import { closeQuietly } from "@magic-context/core/shared/sqlite-helpers";
import type { SubagentRunner } from "@magic-context/core/shared/subagent-runner";
import { createTestTempDir } from "@magic-context/core/shared/test-temp-dir";
import {
	__test,
	awaitInFlightHistorians,
	clearContextHandlerSession,
	type PiContextHandlerOptions,
	registerPiContextHandler,
} from "./context-handler";
import { repairPiHistoryBoundary } from "./history-boundary-repair-pi";
import {
	acknowledgePiHistoryRetirement,
	readPiHistoryRetirement,
} from "./pi-history-retirement";
import {
	assistantMessage,
	createFakePi,
	createTestDb,
	fakeContext,
	userMessage,
} from "./test-utils.test";

function fixture(
	historian?: PiContextHandlerOptions["historian"],
	path?: string,
) {
	let db = createTestDb(path);
	const sessionId = `tree-${crypto.randomUUID()}`;
	const original = Array.from({ length: 8 }, (_, index) => ({
		type: "message",
		id: `e${index + 1}`,
		parentId: index === 0 ? null : `e${index}`,
		timestamp: new Date(1000 + index).toISOString(),
		message:
			index % 2 === 0
				? userMessage(`request ${index}`, index + 1)
				: assistantMessage(`answer ${index}`, index + 1),
	}));
	appendCompartments(
		db,
		sessionId,
		[0, 1, 2].map((sequence) => ({
			sequence,
			startMessage: sequence * 2 + 1,
			endMessage: sequence * 2 + 2,
			startMessageId: `e${sequence * 2 + 1}`,
			endMessageId: `e${sequence * 2 + 2}`,
			title:
				sequence === 0 ? "SHARED_HISTORY" : `ABANDONED_HISTORY_${sequence}`,
			content: "Completed work",
			p1: "Completed work",
		})),
	);
	const fake = createFakePi();
	const register = () =>
		registerPiContextHandler(fake.pi as never, {
			db,
			historian,
			heuristics: {},
			injection: { injectionBudgetTokens: 10000 },
			protectedTags: 1,
			protectedTokens: 1,
		});
	register();
	let branch = original;
	const ctx = () => ({
		...fakeContext(sessionId),
		sessionManager: {
			getSessionId: () => sessionId,
			getLeafId: () => branch.at(-1)?.id ?? null,
			getBranch: () => branch,
			getEntry: (id: string) =>
				original.find((entry) => entry.id === id) ??
				branch.find((entry) => entry.id === id),
		},
	});
	const run = async (start = 0) => {
		branch = structuredClone(branch);
		const messages = branch.slice(start).map((entry) => entry.message);
		const result = (await fake.handlers.get("context")!(
			{ messages } as never,
			ctx() as never,
		)) as { messages: unknown[] } | undefined;
		expect(result).toBeDefined();
		return JSON.stringify(result?.messages);
	};
	return {
		get db() {
			return db;
		},
		sessionId,
		original,
		ctx,
		run,
		setBranch: (next: typeof branch) => {
			branch = next;
		},
		restart: () => {
			clearContextHandlerSession(sessionId);
			closeQuietly(db);
			db = createTestDb(path);
			register();
		},
		close: () => {
			clearContextHandlerSession(sessionId);
			closeQuietly(db);
		},
	};
}

it("unchanged active branch makes no rebuild and replays byte-identical passes", async () => {
	const f = fixture();
	const folds: boolean[] = [];
	const restore = __test.setMutationGateObserverForTests((snapshot) =>
		folds.push(snapshot.foldExecuted),
	);
	try {
		const first = await f.run();
		folds.length = 0;
		expect(await f.run()).toBe(first);
		expect(await f.run()).toBe(first);
		expect(folds).toEqual([false, false]);
		expect(getCompartments(f.db, f.sessionId)).toHaveLength(3);
	} finally {
		restore();
		f.close();
	}
});

it("partial-window request never retires summaries whose ends remain on the active branch", async () => {
	const f = fixture();
	const folds: boolean[] = [];
	const restore = __test.setMutationGateObserverForTests((snapshot) =>
		folds.push(snapshot.foldExecuted),
	);
	try {
		const first = await f.run(6);
		expect(first).toContain("ABANDONED_HISTORY_2");
		folds.length = 0;
		expect(await f.run(6)).toBe(first);
		expect(getCompartments(f.db, f.sessionId)).toHaveLength(3);
		expect(folds).toEqual([false]);
	} finally {
		restore();
		f.close();
	}
});

it("off-branch boundaries retire from the first mismatch with exactly one rebuild", async () => {
	const f = fixture();
	const folds: boolean[] = [];
	const restore = __test.setMutationGateObserverForTests((snapshot) =>
		folds.push(snapshot.foldExecuted),
	);
	try {
		await f.run();
		setPendingPiCompactionMarkerState(f.db, f.sessionId, {
			firstKeptEntryId: "e7",
			endMessageId: "e6",
			ordinal: 6,
			tokensBefore: 100,
			summary: "old marker",
			publishedAt: 1,
		});
		f.db
			.prepare(
				"UPDATE session_meta SET prior_boundary_ordinal = 7 WHERE session_id = ?",
			)
			.run(f.sessionId);
		f.setBranch([
			...f.original.slice(0, 2),
			{ ...f.original[2]!, id: "new3", message: userMessage("NEW_BRANCH", 20) },
		]);
		folds.length = 0;
		const repaired = await f.run();
		expect(repaired).toContain("SHARED_HISTORY");
		expect(repaired).not.toContain("ABANDONED_HISTORY");
		expect(repaired).toContain("NEW_BRANCH");
		expect(getCompartments(f.db, f.sessionId).map((c) => c.sequence)).toEqual([
			0,
		]);
		expect(getPendingPiCompactionMarkerState(f.db, f.sessionId)).toBeNull();
		expect(
			f.db
				.prepare(
					"SELECT prior_boundary_ordinal AS floor FROM session_meta WHERE session_id = ?",
				)
				.get(f.sessionId),
		).toEqual({ floor: 3 });
		expect(await f.run()).toBe(repaired);
		expect(await f.run()).toBe(repaired);
		expect(folds).toEqual([true, false, false]);
		f.setBranch(f.original);
		expect(await f.run()).not.toContain("ABANDONED_HISTORY");
		expect(getCompartments(f.db, f.sessionId)).toHaveLength(1);
	} finally {
		restore();
		f.close();
	}
});

it("jump before the first compartment retires all summaries, but not a broken parent chain", () => {
	const f = fixture();
	try {
		f.setBranch([{ ...f.original[0]!, parentId: "missing-ancestor" }]);
		repairPiHistoryBoundary(f.db, f.sessionId, f.ctx());
		expect(getCompartments(f.db, f.sessionId)).toHaveLength(3);
		f.setBranch(f.original.slice(0, 1));
		expect(
			acquireCompartmentLease(f.db, f.sessionId, "other-writer"),
		).not.toBeNull();
		repairPiHistoryBoundary(f.db, f.sessionId, f.ctx());
		expect(getCompartments(f.db, f.sessionId)).toHaveLength(3);
		releaseCompartmentLeaseBestEffort(f.db, f.sessionId, "other-writer");
		repairPiHistoryBoundary(f.db, f.sessionId, f.ctx());
		expect(getCompartments(f.db, f.sessionId)).toHaveLength(0);
	} finally {
		f.close();
	}
});

it("a synthetic tool-result boundary resolves to its real branch entry", () => {
	const f = fixture();
	try {
		f.db
			.prepare(
				"UPDATE compartments SET end_message_id = 'synth-user-e6' WHERE session_id = ? AND sequence = 2",
			)
			.run(f.sessionId);
		repairPiHistoryBoundary(f.db, f.sessionId, f.ctx());
		expect(getCompartments(f.db, f.sessionId)).toHaveLength(3);
	} finally {
		f.close();
	}
});

it("an on-branch newest end does not conceal an earlier off-branch boundary", () => {
	const f = fixture();
	try {
		f.db
			.prepare(
				"UPDATE compartments SET end_message_id = 'old-sibling' WHERE session_id = ? AND sequence = 1",
			)
			.run(f.sessionId);
		repairPiHistoryBoundary(f.db, f.sessionId, f.ctx());
		expect(getCompartments(f.db, f.sessionId).map((c) => c.sequence)).toEqual([
			0,
		]);
	} finally {
		f.close();
	}
});

for (const restart of [false, true]) {
	it(`retirement schedules a small eligible range${restart ? " after restart" : ""}, retains failed work with backoff, and clears on publication`, async () => {
		let succeed = false;
		let calls = 0;
		const runner = {
			run: async (options: { userMessage: string }) => {
				calls++;
				if (!succeed)
					return {
						ok: true,
						assistantText: "invalid historian output",
						sessionId: "child",
					};
				const match = /Messages (\d+)-(\d+):/.exec(options.userMessage);
				if (!match) throw new Error("Missing historian source range");
				const start = Number(match[1]);
				const end = Number(match[2]);
				return {
					ok: true,
					sessionId: "child",
					assistantText: `<output><compartments><compartment start="${start}" end="${end}" title="RECOVERED_SHARED_RANGE" importance="80" episode_type="investigation"><p1>Recovered shared work.</p1><p2>Recovered work.</p2><p3>Work.</p3><p4/></compartment></compartments><facts/><events/><unprocessed_from>${end + 1}</unprocessed_from></output>`,
				};
			},
		} as unknown as SubagentRunner;
		const { dir } = createTestTempDir("pi-retirement-");
		const f = fixture(
			{
				runner,
				model: "test-provider/test-model",
				historianChunkTokens: 50000,
				memoryEnabled: false,
				autoPromote: false,
			},
			join(dir, "context.db"),
		);
		try {
			// The normal size trigger must stay idle for this same small history.
			await f.run();
			await awaitInFlightHistorians(f.sessionId);
			expect(calls).toBe(0);
			f.setBranch([
				...f.original.slice(0, 3),
				...Array.from({ length: 5 }, (_, i) => ({
					...f.original[i + 3]!,
					id: `new${i + 4}`,
					parentId: i === 0 ? "e3" : `new${i + 3}`,
					message:
						i % 2 === 0
							? assistantMessage(`new answer ${i}`, 20 + i)
							: userMessage(`new request ${i}`, 20 + i),
				})),
			]);
			repairPiHistoryBoundary(f.db, f.sessionId, f.ctx());
			expect(readPiHistoryRetirement(f.db, f.sessionId)).toBe("e3");
			if (restart) {
				f.db
					.prepare(
						"UPDATE session_meta SET compartment_in_progress = 1 WHERE session_id = ?",
					)
					.run(f.sessionId);
				f.restart();
			}
			expect(readPiHistoryRetirement(f.db, f.sessionId)).toBe("e3");
			await f.run();
			await awaitInFlightHistorians(f.sessionId);
			expect(calls).toBeGreaterThan(0);
			expect(readPiHistoryRetirement(f.db, f.sessionId)).toBe("e3");
			const afterFailure = calls;
			await f.run();
			await awaitInFlightHistorians(f.sessionId);
			expect(calls).toBe(afterFailure);
			// Expire the persisted normal failure backoff without a wall-clock wait.
			f.db
				.prepare(
					"UPDATE session_meta SET historian_last_failure_at = 0, historian_drain_failure_at = 0, protected_tail_drain_window_started_at = 0 WHERE session_id = ?",
				)
				.run(f.sessionId);
			succeed = true;
			await f.run();
			await awaitInFlightHistorians(f.sessionId);
			expect(calls).toBeGreaterThan(afterFailure);
			expect(readPiHistoryRetirement(f.db, f.sessionId)).toBeNull();
			expect(getCompartments(f.db, f.sessionId).at(-1)?.title).toBe(
				"RECOVERED_SHARED_RANGE",
			);
		} finally {
			f.close();
		}
	});
}

it("partial publication keeps the durable target and unrelated metadata namespaces", () => {
	const f = fixture();
	try {
		getOrCreateSessionMeta(f.db, f.sessionId);
		f.db
			.prepare(
				"UPDATE session_meta SET deferred_execute_state = ? WHERE session_id = ?",
			)
			.run(JSON.stringify({ unrelated: { value: "keep" } }), f.sessionId);
		f.setBranch(f.original.slice(0, 3));
		repairPiHistoryBoundary(f.db, f.sessionId, f.ctx());
		expect(readPiHistoryRetirement(f.db, f.sessionId)).toBe("e3");
		f.db
			.transaction(() =>
				acknowledgePiHistoryRetirement(f.db, f.sessionId, 2, () => 3),
			)
			.immediate();
		expect(readPiHistoryRetirement(f.db, f.sessionId)).toBe("e3");
		f.db
			.transaction(() =>
				acknowledgePiHistoryRetirement(f.db, f.sessionId, 3, () => 3),
			)
			.immediate();
		expect(readPiHistoryRetirement(f.db, f.sessionId)).toBeNull();
		const row = f.db
			.prepare(
				"SELECT deferred_execute_state AS state FROM session_meta WHERE session_id = ?",
			)
			.get(f.sessionId) as { state: string };
		expect(JSON.parse(row.state)).toEqual({ unrelated: { value: "keep" } });
	} finally {
		f.close();
	}
});
