import { expect, spyOn, test } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as sqlite from "@magic-context/core/shared/sqlite";
import { Database } from "@magic-context/core/shared/sqlite";
import { createTestTempDirFromPath } from "../../plugin/src/shared/test-temp-dir";
import {
	clearContextHandlerSession,
	registerPiContextHandler,
} from "./context-handler";
import {
	createFakePi,
	createTestDb,
	fakeContext,
	userMessage,
} from "./test-utils.test";

async function underWriter(
	run: (
		db: ReturnType<typeof createTestDb>,
		locker: Database,
		dir: string,
	) => Promise<void>,
) {
	const dir = createTestTempDirFromPath(join(tmpdir(), "pi-writer-wait-"));
	const db = createTestDb(join(dir, "context.db"));
	const locker = new Database(join(dir, "context.db"));
	locker.exec("BEGIN IMMEDIATE");
	try {
		await run(db, locker, dir);
	} finally {
		if (locker.inTransaction) locker.exec("ROLLBACK");
		locker.close();
		db.close();
		clearContextHandlerSession("waiter");
		rmSync(dir, { recursive: true, force: true });
	}
}

function install(db: ReturnType<typeof createTestDb>) {
	const fake = createFakePi();
	Object.assign(fake.pi, { getAllTools: () => [] });
	registerPiContextHandler(fake.pi as never, { db });
	const handler = fake.handlers.get("context");
	if (!handler) throw new Error("Context handler not installed");
	return handler as unknown as (
		event: { messages: ReturnType<typeof userMessage>[] },
		ctx: unknown,
	) => Promise<unknown>;
}

function observeWriterWait(onWait: () => void) {
	const writer = sqlite.withAsyncPrivilegedWriter;
	return spyOn(sqlite, "withAsyncPrivilegedWriter").mockImplementation(
		(db, operation, options) =>
			writer(db, operation, {
				...options,
				beforeRetry: (error) => {
					options?.beforeRetry?.(error);
					// Serving a saved request throws from beforeRetry; only a writer
					// that must wait for the lock reaches this callback.
					onWait();
				},
			}),
	);
}

for (const warmSnapshot of [true, false]) {
	test(
		warmSnapshot
			? "Pi bounds a native read by the remaining turn allowance before writer admission"
			: "Pi bounds rooted snapshot preparation while a turn awaits hydration",
		async () => {
			const dir = createTestTempDirFromPath(join(tmpdir(), "pi-native-read-"));
			const path = join(dir, "context.db");
			const db = createTestDb(path);
			db.exec("PRAGMA journal_mode=DELETE; PRAGMA busy_timeout=900");
			const handler = install(db);
			if (warmSnapshot) {
				const warm = [userMessage("late native read", 1)];
				await handler(
					{ messages: warm },
					fakeContext("waiter", dir, ["u"], warm),
				);
				await new Promise<void>((resolve) => setImmediate(resolve));
			}
			const holder = Bun.spawn(
				[
					process.execPath,
					"-e",
					`
		const { Database } = require('bun:sqlite');
		const db = new Database(process.argv[1]);
		db.exec('PRAGMA busy_timeout=5000; BEGIN EXCLUSIVE'); console.log('HELD');
		setInterval(() => {}, 1000);
	`,
					path,
				],
				{ stdout: "pipe", stderr: "pipe", windowsHide: true },
			);
			const ready = holder.stdout.getReader();
			const first = await ready.read();
			ready.releaseLock();
			expect(new TextDecoder().decode(first.value)).toContain("HELD");
			const start = performance.now();
			// Shorten the registered turn's native allowance without delaying the suite
			// for 23 seconds. This still executes the real handler and native lock wait.
			const deadline = sqlite.withSqliteTurnDeadline;
			const remaining = spyOn(
				sqlite,
				"withSqliteTurnDeadline",
			).mockImplementation((remainingMs, operation) =>
				deadline(
					() =>
						Math.min(
							remainingMs(),
							Math.max(0, 80 - (performance.now() - start)),
						),
					operation,
				),
			);
			let aborted = false;
			try {
				const raw = [userMessage("late native read", 1)];
				await handler(
					{ messages: raw },
					Object.assign(fakeContext("waiter", dir, ["u"], raw), {
						abort: () => {
							aborted = true;
						},
					}),
				);
				expect(aborted).toBe(true);
				expect(performance.now() - start).toBeLessThan(500);
			} finally {
				remaining.mockRestore();
				holder.kill();
				await holder.exited;
				db.close();
				clearContextHandlerSession("waiter");
				rmSync(dir, { recursive: true, force: true });
			}
		},
	);
}

test("a usable Pi LKG is replayed before any backed-off writer wait", async () => {
	await underWriter(async (db, locker, dir) => {
		locker.exec("ROLLBACK");
		const handler = install(db);
		const raw = [userMessage("saved prefix", 1)];
		const ctx = Object.assign(fakeContext("waiter", dir, ["u"], raw), {
			model: {
				provider: "openai-codex",
				id: "gpt-5.6-sol",
				contextWindow: 272000,
				maxTokens: 68000,
			},
			getSystemPrompt: () => "current system",
		});
		const first = await handler({ messages: structuredClone(raw) }, ctx);
		await new Promise((done) => setImmediate(done));
		locker.exec("BEGIN IMMEDIATE");
		let backoffs = 0;
		const wait = observeWriterWait(() => {
			backoffs++;
			throw new Error("LKG replay entered a backed-off writer wait");
		});
		try {
			const replay = await handler({ messages: structuredClone(raw) }, ctx);
			expect(replay).toEqual(first);
			expect(wait).toHaveBeenCalledTimes(1);
			expect(backoffs).toBe(0);
			expect(locker.inTransaction).toBe(true);
		} finally {
			wait.mockRestore();
		}
	});
});

test("Pi session metadata is read inside the acquired transaction, not after an empty preflight", async () => {
	const db = createTestDb();
	const prepare = db.prepare.bind(db);
	let firstReadHeld: boolean | undefined;
	const spy = spyOn(db, "prepare").mockImplementation((sql) => {
		const statement = prepare(sql);
		// Tag-version readiness stamps are not the session state consumed by a
		// transform. Observe execution of the full metadata projection, not when
		// a statement was merely prepared before writer admission.
		if (
			!sql.includes("FROM session_meta") ||
			!sql.includes("last_response_time")
		)
			return statement;
		return new Proxy(statement, {
			get(target, key) {
				const value = Reflect.get(target, key);
				if (key === "get")
					return (...args: unknown[]) => {
						firstReadHeld ??= db.inTransaction;
						return Reflect.apply(value, target, args);
					};
				return typeof value === "function" ? value.bind(target) : value;
			},
		});
	});
	try {
		const raw = [userMessage("unsent request", 1)];
		const handler = install(db);
		const ctx = fakeContext("waiter", process.cwd(), ["u"], raw);
		const first = await handler({ messages: structuredClone(raw) }, ctx);
		expect(firstReadHeld).toBe(true);
		// Repeat the same raw history without sending the first output or emitting
		// message_end: stored tags must replay even when the request was abandoned.
		const next = await handler({ messages: structuredClone(raw) }, ctx);
		expect(next).toEqual(first);
	} finally {
		spy.mockRestore();
		db.close();
		clearContextHandlerSession("waiter");
	}
});

test("Pi writer wait yields and performs the actual managed write after release", async () => {
	await underWriter(async (db, locker, dir) => {
		const handler = install(db);
		const raw = [userMessage("new turn", 1)];
		const entered = Promise.withResolvers<void>();
		const wait = observeWriterWait(() => entered.resolve());
		try {
			const pending = handler(
				{ messages: raw },
				fakeContext("waiter", dir, ["u"], raw),
			);
			await Promise.race([
				entered.promise,
				pending.then(() => {
					throw new Error(
						"Pi request completed without entering the writer wait",
					);
				}),
			]);
			expect(locker.inTransaction).toBe(true);
			await new Promise<void>((done) => setImmediate(done));
			locker.exec("ROLLBACK");
			const result = await pending;
			expect(JSON.stringify(result)).toContain("§");
			expect(
				db
					.prepare(
						"SELECT session_id FROM session_meta WHERE session_id='waiter'",
					)
					.get(),
			).toBeDefined();
		} finally {
			wait.mockRestore();
		}
	});
});

test("Pi writer wait honours a supplied host abort signal before writes", async () => {
	await underWriter(async (db, _locker, dir) => {
		const handler = install(db);
		const controller = new AbortController();
		const raw = [userMessage("cancelled", 1)];
		const ctx = Object.assign(fakeContext("waiter", dir, ["u"], raw), {
			signal: controller.signal,
		});
		const entered = Promise.withResolvers<void>();
		const wait = observeWriterWait(() => entered.resolve());
		try {
			const pending = handler({ messages: raw }, ctx);
			void pending.catch(() => {});
			await entered.promise;
			controller.abort(new Error("host cancelled"));
			expect(await pending).toBeUndefined();
		} finally {
			wait.mockRestore();
		}
		expect(
			db.prepare("SELECT * FROM session_meta WHERE session_id='waiter'").get(),
		).toBeNull();
	});
});

test("a superseded Pi waiter never writes or aborts the newer pass", async () => {
	await underWriter(async (db, locker, dir) => {
		const handler = install(db);
		const older = [userMessage("abandoned old input", 1)];
		let oldAborts = 0;
		const oldCtx = Object.assign(fakeContext("waiter", dir, ["old"], older), {
			abort: () => {
				oldAborts++;
			},
		});
		const oldEntered = Promise.withResolvers<void>();
		const newEntered = Promise.withResolvers<void>();
		let attempts = 0;
		const wait = observeWriterWait(() => {
			(attempts++ === 0 ? oldEntered : newEntered).resolve();
		});
		const old = handler({ messages: older }, oldCtx).then(
			() => "unexpected success",
			(error: Error) => error.message,
		);
		await oldEntered.promise;
		const newer = [userMessage("replacement input", 2)];
		const current = handler(
			{ messages: newer },
			fakeContext("waiter", dir, ["new"], newer),
		);
		try {
			await Promise.race([
				newEntered.promise,
				current.then(() => {
					throw new Error(
						"Replacement request completed without entering the writer wait",
					);
				}),
			]);
			expect(await old).toContain("superseded");
			locker.exec("ROLLBACK");
			const result = await current;
			expect(oldAborts).toBe(0);
			expect(JSON.stringify(result)).toContain("replacement input");
			expect(JSON.stringify(result)).not.toContain("abandoned old input");
			expect(
				db
					.prepare("SELECT message_id FROM tags WHERE session_id='waiter'")
					.all()
					.every(
						(row) =>
							!(row as { message_id: string }).message_id.startsWith("old"),
					),
			).toBe(true);
		} finally {
			wait.mockRestore();
		}
	});
});
