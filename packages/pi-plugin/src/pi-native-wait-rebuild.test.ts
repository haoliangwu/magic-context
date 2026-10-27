import { expect, spyOn, test } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendCompartments } from "@magic-context/core/features/magic-context/compartment-storage";
import { updateSessionMeta } from "@magic-context/core/features/magic-context/storage";
import { Database } from "@magic-context/core/shared/sqlite";
import { createTestTempDirFromPath } from "../../plugin/src/shared/test-temp-dir";
import {
	clearContextHandlerSession,
	__test as internals,
	registerPiContextHandler,
	signalPiHistoryRefresh,
	signalPiPendingMaterialization,
} from "./context-handler";
import { injectM0M1Pi } from "./inject-compartments-pi";
import { PiContextBudget } from "./pi-context-budget";
import { contextHost } from "./pi-context-host.test";
import {
	assistantMessage,
	createFakePi,
	createTestDb,
	fakeContext,
	userMessage,
} from "./test-utils.test";

async function fixture(
	run: (f: {
		db: ReturnType<typeof createTestDb>;
		locker: Database;
		session: string;
		pass: (
			raw: ReturnType<typeof userMessage>[],
			throughHost?: boolean,
		) => Promise<unknown>;
		host: ReturnType<typeof contextHost>;
	}) => Promise<void>,
) {
	const dir = createTestTempDirFromPath(join(tmpdir(), "pi-native-rebuild-"));
	const db = createTestDb(join(dir, "context.db"));
	const locker = new Database(join(dir, "context.db"));
	const session = "native-rebuild";
	const host = contextHost();
	const fake = createFakePi();
	Object.assign(fake.pi, host.api, { getAllTools: () => [] });
	updateSessionMeta(db, session, { piStableIdScheme: 1 });
	registerPiContextHandler(fake.pi as never, {
		db,
		protectedTags: 0,
		injection: { injectionBudgetTokens: 10000 },
		scheduler: { executeThresholdPercentage: 80 },
	});
	const handler = fake.handlers.get("context") as (
		event: unknown,
		ctx: unknown,
	) => Promise<unknown>;
	const pass = (raw: ReturnType<typeof userMessage>[], throughHost = false) => {
		const ctx = Object.assign(
			fakeContext(
				session,
				dir,
				raw.map((_, i) => `entry-${i + 1}`),
				raw,
			),
			{
				model: {
					provider: "openai-codex",
					id: "gpt-5.6-sol",
					contextWindow: 272000,
					maxTokens: 68000,
				},
				getSystemPrompt: () => "Complete system prompt.",
			},
		);
		return throughHost
			? host.emit(handler as never, raw, ctx)
			: handler({ messages: raw }, ctx);
	};
	try {
		await run({ db, locker, session, pass, host });
	} finally {
		if (locker.inTransaction) locker.exec("ROLLBACK");
		locker.close();
		db.close();
		clearContextHandlerSession(session);
		rmSync(dir, { recursive: true, force: true });
	}
}

test("a rebuild deferred by writer contention is consumed exactly once after release", async () => {
	await fixture(async ({ db, locker, session, pass }) => {
		const raw = () => [
			userMessage("covered request", 1),
			assistantMessage("covered answer", 2),
			userMessage("live tail", 3),
		];
		await pass(raw());
		await new Promise<void>((resolve) => setImmediate(resolve));
		appendCompartments(db, session, [
			{
				sequence: 0,
				startMessage: 1,
				endMessage: 2,
				startMessageId: "entry-1",
				endMessageId: "entry-2",
				title: "Deferred rebuild",
				content: "U: covered request\nA: covered answer",
				p1: "U: covered request\nA: covered answer",
			},
		]);
		signalPiHistoryRefresh(session);
		signalPiPendingMaterialization(session);
		let freshRenders = 0;
		const restoreInject = internals.setInjectM0M1PiForTests(
			(state, ...args) => {
				const prepared = !!state.preparedPrefix;
				const result = injectM0M1Pi(state, ...args);
				if (!prepared && result.m1RenderedCoverage != null) freshRenders++;
				return result;
			},
		);
		// Exercise the same admission expiry with a short allowance, not a 16.5s test.
		const allowance = spyOn(
			PiContextBudget.prototype,
			"writerAllowance",
		).mockReturnValue(80);
		locker.exec("BEGIN IMMEDIATE");
		try {
			await pass(raw(), true);
			expect(freshRenders).toBe(0);
			expect(internals.variantRefreshStateForTests(session).history).toBe(true);
			expect(locker.inTransaction).toBe(true);
			locker.exec("ROLLBACK");
			const rebuilt = await pass(raw());
			expect(JSON.stringify(rebuilt)).toContain("Deferred rebuild");
			expect(freshRenders).toBe(1);
			expect(internals.variantRefreshStateForTests(session).history).toBe(
				false,
			);
			const next = await pass(raw());
			expect(next).toEqual(rebuilt);
			expect(freshRenders).toBe(1);
		} finally {
			allowance.mockRestore();
			restoreInject();
		}
	});
});

test("writer contention still refuses an oversized LKG replay with a complete fit envelope", async () => {
	await fixture(async ({ locker, pass, host }) => {
		await pass([userMessage("saved prefix", 1)]);
		await new Promise<void>((resolve) => setImmediate(resolve));
		const logs: string[] = [];
		const restoreLog = internals.setLkgRecoveryLogObserverForTests((line) =>
			logs.push(line),
		);
		const allowance = spyOn(
			PiContextBudget.prototype,
			"writerAllowance",
		).mockReturnValue(80);
		locker.exec("BEGIN IMMEDIATE");
		try {
			const raw = [
				userMessage("saved prefix", 1),
				assistantMessage("word ".repeat(400000), 2),
			];
			const pristine = structuredClone(raw);
			const served = await pass(raw, true);
			host.assertRefused(served as never[], pristine);
			expect(
				logs.some((line) => line.includes("raw_fallback_over_context_limit")),
			).toBe(true);
		} finally {
			allowance.mockRestore();
			restoreLog();
		}
	});
});
