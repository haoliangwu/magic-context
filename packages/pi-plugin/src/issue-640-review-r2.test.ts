import { expect, spyOn, test } from "bun:test";
import * as embedding from "@magic-context/core/features/magic-context/memory/embedding";
import * as projectIdentity from "@magic-context/core/features/magic-context/memory/project-identity";
import { getAutoSearchHintDecisions } from "@magic-context/core/features/magic-context/storage-meta-persisted";
import { getPendingOps } from "@magic-context/core/features/magic-context/storage-ops";
import {
	adoptPiFallbackMessageTag,
	PiTagIdentityConflictError,
} from "@magic-context/core/features/magic-context/storage-tags";
import { createTagger } from "@magic-context/core/features/magic-context/tagger";
import { autoSearchTestSnapshot } from "@magic-context/core/hooks/magic-context/auto-search-snapshot.fixture";
import * as search from "@magic-context/core/hooks/magic-context/auto-search-worker-client";
import {
	getSlot,
	resetLkgSlotsForTest,
} from "@magic-context/core/hooks/magic-context/lkg-slot";
import {
	__test,
	clearContextHandlerSession,
	registerPiContextHandler,
} from "./context-handler";
import { createPiLkgCoordinator } from "./pi-lkg";
import { observePiPublicationForTest } from "./publication-observer-fixture.test";
import { capturePiServedArray } from "./served-array-ledger";
import {
	createFakePi,
	createTestDb,
	fakeContext,
	type PiMessage,
	textOf,
	userMessage,
} from "./test-utils.test";

type Handler = (
	event: { messages: PiMessage[] },
	ctx: ReturnType<typeof fakeContext>,
) => Promise<{ messages: PiMessage[] }>;
function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

for (const cancellation of ["successor", "signal"] as const) {
	test(`r2: ${cancellation} fences real auto-search continuation and LKG publication`, async () => {
		const db = createTestDb();
		const sessionId = `r2-search-${cancellation}`;
		const paused =
			deferred<Awaited<ReturnType<typeof search.searchAutoHint>>>();
		const entered = deferred<void>();
		const spy = spyOn(search, "searchAutoHint").mockImplementation(() => {
			entered.resolve();
			return paused.promise;
		});
		const snapshot = spyOn(
			embedding,
			"getProjectEmbeddingSnapshot",
		).mockReturnValue(
			autoSearchTestSnapshot("github.com/cortexkit/magic-context"),
		);
		const identity = spyOn(
			projectIdentity,
			"resolveProjectIdentityForSession",
		).mockReturnValue("github.com/cortexkit/magic-context");
		const fake = createFakePi();
		registerPiContextHandler(fake.pi as never, {
			db,
			autoSearch: { enabled: true, minPromptChars: 1, scoreThreshold: 0.55 },
		});
		const handler = fake.handlers.get("context") as unknown as Handler;
		const controller = new AbortController();
		const raw = [
			userMessage(
				"Please find the previous implementation of writer admission",
			),
		];
		const old = handler(
			{ messages: raw },
			{
				...fakeContext(sessionId, process.cwd(), ["old"], raw),
				signal: controller.signal,
			},
		).catch((error: Error) => error);
		try {
			await entered.promise;
			if (cancellation === "signal")
				controller.abort(new Error("cancelled search"));
			else {
				const newer = [userMessage("x", 2)];
				// A stacked augmentation skips search on the successor, avoiding the paused query.
				newer[0] = userMessage(
					"<ctx-search-hint>already searched</ctx-search-hint>",
					2,
				);
				await handler(
					{ messages: newer },
					fakeContext(sessionId, process.cwd(), ["new"], newer),
				);
			}
			paused.resolve([]);
			const outcome = await old;
			if (cancellation === "signal") expect(outcome).toBeUndefined();
			else
				expect((outcome as Error).message).toBe(
					"Pi context pass superseded: no longer valid for this operation",
				);
			await new Promise<void>((done) => setImmediate(done));
			expect(getSlot(sessionId)?.jsonPrefix ?? "").not.toContain(
				"previous implementation",
			);
			expect(
				getAutoSearchHintDecisions(db, sessionId).map(
					(decision) => decision.messageId,
				),
			).not.toContain("old");
		} finally {
			paused.resolve([]);
			await old;
			spy.mockRestore();
			snapshot.mockRestore();
			identity.mockRestore();
			clearContextHandlerSession(sessionId);
			resetLkgSlotsForTest();
			db.close();
		}
	});
}

for (const api of [
	"azure-openai-responses",
	"bedrock-converse-stream",
	"future-whole-context-api",
]) {
	test(`r2: unproved ${api} preserves the root LKG content fence`, () => {
		const db = createTestDb();
		let flush!: () => void;
		const coordinator = createPiLkgCoordinator(db, (capture) => {
			flush = capture;
		});
		const raw = [
			{
				role: "user",
				content: "question",
				timestamp: 1,
				contextSnapshot: "old",
			},
		];
		const begin = (messages: unknown[]) =>
			coordinator.beginPass({
				sessionId: api,
				messages,
				entryIds: ["u"],
				modelKey: "test/model",
				providerKey: "test",
				apiKey: api,
			});
		try {
			const snapshot = begin(raw);
			coordinator.captureAppliedPass({
				snapshot,
				outputMessages: raw,
				outputEntryIds: ["u"],
				cacheBusting: false,
			});
			flush();
			const next = structuredClone(raw);
			next[0].contextSnapshot = "new";
			expect(coordinator.replay(begin(next))).toEqual({
				ok: false,
				reason: "lkg_content_mismatch",
			});
		} finally {
			clearContextHandlerSession(api);
			resetLkgSlotsForTest();
			db.close();
		}
	});
}

test("r2: distinct multi-block real messages must not collide with one served fallback", async () => {
	const db = createTestDb();
	const sessionId = "r2-identical-real";
	const publication = observePiPublicationForTest(sessionId);
	const fake = createFakePi();
	registerPiContextHandler(fake.pi as never, { db });
	const handler = fake.handlers.get("context") as unknown as Handler;
	const raw = [
		userMessage(
			[
				{ type: "text", text: "repeat" },
				{ type: "text", text: "alpha" },
			],
			1,
		),
		userMessage(
			[
				{ type: "text", text: "repeat" },
				{ type: "text", text: "beta" },
			],
			1,
		),
	];
	try {
		const real = await handler(
			{ messages: [structuredClone(raw[0])] },
			fakeContext(sessionId, process.cwd(), ["first"], [raw[0]]),
		);
		expect(textOf(real.messages[0])).toBe("§1§ repeat§2§ alpha");
		publication.reset();
		const unavailable = fakeContext(sessionId);
		unavailable.sessionManager.getBranch = () => {
			throw new Error("entry unavailable");
		};
		const fallback = await handler(
			{ messages: [structuredClone(raw[1])] },
			unavailable,
		);
		expect(textOf(fallback.messages[0])).toBe("§3§ repeat§4§ beta");
		expect(getSlot(sessionId)?.jsonPrefix).toBe(JSON.stringify(real.messages));
		publication.expect("numbers_only", "lkg_entry_ids_unavailable", 1);
		const result = await handler(
			{ messages: structuredClone(raw) },
			fakeContext(sessionId, process.cwd(), ["first", "second"], raw),
		).catch((error: Error) => error);
		expect(result).not.toBeInstanceOf(Error);
		if (!(result instanceof Error))
			expect(result.messages.map(textOf)).toEqual([
				"§1§ repeat§2§ alpha",
				"§3§ repeat§4§ beta",
			]);
	} finally {
		publication.restore();
		clearContextHandlerSession(sessionId);
		resetLkgSlotsForTest();
		db.close();
	}
});

test("r2: an unserved racing real row is not served evidence merely because user text mentions its number", async () => {
	const db = createTestDb();
	const sessionId = "r2-literal-marker";
	const publication = observePiPublicationForTest(sessionId);
	const fake = createFakePi();
	registerPiContextHandler(fake.pi as never, { db });
	const handler = fake.handlers.get("context") as unknown as Handler;
	const original = userMessage(
		"Explain the marker §9§ in this pasted example",
		1,
	);
	try {
		const unavailable = fakeContext(sessionId);
		unavailable.sessionManager.getBranch = () => {
			throw new Error("entry unavailable");
		};
		const first = await handler(
			{ messages: [structuredClone(original)] },
			unavailable,
		);
		expect(textOf(first.messages[0])).toBe(
			"§1§ Explain the marker §9§ in this pasted example",
		);
		expect(getSlot(sessionId)).toBeUndefined();
		publication.expect("numbers_only", "lkg_entry_ids_unavailable", 1);
		db.prepare(
			"INSERT INTO tags(message_id,type,status,session_id,tag_number,byte_size) VALUES ('real:p0','message','active',?,9,0)",
		).run(sessionId);
		db.prepare(
			"INSERT INTO source_contents(tag_id,session_id,content,created_at,harness) VALUES (9,?,?,0,'pi')",
		).run(sessionId, textOf(original));
		const next = [structuredClone(original)];
		const result = await handler(
			{ messages: next },
			fakeContext(sessionId, process.cwd(), ["real"], next),
		).catch((error: Error) => error);
		expect(result).not.toBeInstanceOf(Error);
		if (!(result instanceof Error))
			expect(textOf(result.messages[0])).toBe(textOf(first.messages[0]));
	} finally {
		publication.restore();
		clearContextHandlerSession(sessionId);
		resetLkgSlotsForTest();
		db.close();
	}
});

test("r2: three-row unserved ordinal collision refuses without changing any row", () => {
	const db = createTestDb();
	const sessionId = "r2-three-way";
	const raw = userMessage("same identity", 1);
	const fingerprint = __test
		.buildEntryFingerprintMap([raw], () => "real")
		.get("real");
	try {
		if (fingerprint === undefined)
			throw new Error("fixture fingerprint missing");
		for (const [id, number] of [
			["pi-msg-a:p0", 1],
			["pi-msg-a:p1", 2],
			["real:p0", 9],
		] as const)
			db.prepare(
				"INSERT INTO tags(message_id,type,status,session_id,tag_number,byte_size,entry_fingerprint) VALUES (?,'message','active',?,?,0,?)",
			).run(id, sessionId, number, fingerprint);
		expect(() =>
			__test.adoptPiFallbackTags(
				db,
				sessionId,
				createTagger(),
				new Map([["real", fingerprint]]),
			),
		).toThrow(PiTagIdentityConflictError);
		expect(
			db
				.prepare("SELECT message_id,tag_number FROM tags ORDER BY tag_number")
				.all(),
		).toEqual([
			{ message_id: "pi-msg-a:p0", tag_number: 1 },
			{ message_id: "pi-msg-a:p1", tag_number: 2 },
			{ message_id: "real:p0", tag_number: 9 },
		]);
	} finally {
		clearContextHandlerSession(sessionId);
		resetLkgSlotsForTest();
		db.close();
	}
});

test("r2: three-way collision folds only unserved duplicates into the served fallback", () => {
	const db = createTestDb();
	const sessionId = "r2-true-three-way";
	try {
		for (const number of [1, 9, 10])
			db.prepare(
				"INSERT INTO tags(message_id,type,status,session_id,tag_number,byte_size) VALUES (?,'message','active',?,?,0)",
			).run(number === 1 ? "pi-msg-a:p0" : "real:p0", sessionId, number);
		capturePiServedArray(sessionId, ["§1§ actually returned"]);
		expect(
			adoptPiFallbackMessageTag(
				db,
				sessionId,
				1,
				"pi-msg-a:p0",
				"real:p0",
				new Set([1]),
			),
		).toEqual({ action: "folded", tagNumber: 1, deletedTagNumbers: [9, 10] });
		expect(db.prepare("SELECT message_id,tag_number FROM tags").all()).toEqual([
			{ message_id: "real:p0", tag_number: 1 },
		]);
	} finally {
		clearContextHandlerSession(sessionId);
		db.close();
	}
});

test("r2: same-connection revision change discovers a historical fallback drop", async () => {
	const db = createTestDb();
	const sessionId = "r2-local-revision";
	const fake = createFakePi();
	registerPiContextHandler(fake.pi as never, { db });
	const handler = fake.handlers.get("context") as unknown as Handler;
	const historical = userMessage("historical text", 1);
	let restore: (() => void) | undefined;
	try {
		const first = await handler(
			{ messages: [structuredClone(historical)] },
			fakeContext(sessionId, process.cwd(), ["history"], [historical]),
		);
		expect(textOf(first.messages[0])).toBe("§1§ historical text");
		const fingerprint = __test
			.buildEntryFingerprintMap([historical], () => "history")
			.get("history");
		const prepare = db.prepare.bind(db);
		let inserted = false;
		const spy = spyOn(db, "prepare").mockImplementation((sql) => {
			if (
				sql === "SELECT total_changes() AS changes" &&
				!db.inTransaction &&
				!inserted
			) {
				inserted = true;
				prepare(
					"INSERT INTO tags(message_id,type,status,session_id,tag_number,byte_size,entry_fingerprint) VALUES ('pi-msg-local:p0','message','dropped',?,9,0,?)",
				).run(sessionId, fingerprint);
			}
			return prepare(sql);
		});
		restore = () => spy.mockRestore();
		const next = [structuredClone(historical), userMessage("tail", 2)];
		// The changed local revision must discover the dropped alias, preserving
		// active bytes now and leaving the drop queued for a later execute.
		const result = await handler(
			{ messages: next },
			fakeContext(sessionId, process.cwd(), ["history", "tail"], next),
		);
		expect(inserted).toBe(true);
		expect(textOf(result.messages[0])).toBe("§1§ historical text");
		expect(getPendingOps(db, sessionId).map((op) => op.tagId)).toEqual([1]);
		expect(
			db
				.prepare(
					"SELECT tag_number,status FROM tags WHERE session_id=? AND tag_number IN (1,9) ORDER BY tag_number",
				)
				.all(sessionId),
		).toEqual([{ tag_number: 1, status: "active" }]);
	} finally {
		restore?.();
		clearContextHandlerSession(sessionId);
		resetLkgSlotsForTest();
		db.close();
	}
});

test("r2: an event-aborted waiter superseded twice never aborts the latest turn", async () => {
	const db = createTestDb();
	const sessionId = "r2-three-generations";
	const fake = createFakePi();
	registerPiContextHandler(fake.pi as never, { db });
	const handler = fake.handlers.get("context") as unknown as Handler;
	const entered = deferred<void>();
	const controller = new AbortController();
	let aborts = 0;
	const exec = db.exec.bind(db);
	let begins = 0;
	const spy = spyOn(db, "exec").mockImplementation((sql) => {
		if (sql === "BEGIN IMMEDIATE" && ++begins === 1) {
			entered.resolve();
			throw Object.assign(new Error("busy"), { code: "SQLITE_BUSY" });
		}
		return exec(sql);
	});
	const raw = [userMessage("old waiting input")];
	const old = handler(
		{ messages: raw, signal: controller.signal } as { messages: PiMessage[] },
		{
			...fakeContext(sessionId, process.cwd(), ["old"], raw),
			abort: () => {
				aborts++;
			},
		} as ReturnType<typeof fakeContext>,
	).catch((error: Error) => error);
	try {
		await entered.promise;
		for (const id of ["middle", "latest"]) {
			const next = [userMessage(id, 2)];
			await handler(
				{ messages: next },
				fakeContext(sessionId, process.cwd(), [id], next),
			);
		}
		controller.abort(new Error("host abandoned old event"));
		expect(await old).toBeUndefined();
		expect(aborts).toBe(0);
	} finally {
		spy.mockRestore();
		clearContextHandlerSession(sessionId);
		resetLkgSlotsForTest();
		db.close();
	}
});

test("r2: reloading a session must not forget its already-served fallback number", async () => {
	const db = createTestDb();
	const sessionId = "r2-reload-served";
	const publication = observePiPublicationForTest(sessionId);
	const original = userMessage("served before restart", 1);
	const install = () => {
		const fake = createFakePi();
		registerPiContextHandler(fake.pi as never, { db });
		return fake.handlers.get("context") as unknown as Handler;
	};
	try {
		const unavailable = fakeContext(sessionId);
		unavailable.sessionManager.getBranch = () => {
			throw new Error("entry unavailable");
		};
		const first = await install()(
			{ messages: [structuredClone(original)] },
			unavailable,
		);
		expect(textOf(first.messages[0])).toBe("§1§ served before restart");
		expect(getSlot(sessionId)).toBeUndefined();
		publication.expect("numbers_only", "lkg_entry_ids_unavailable", 1);
		db.prepare(
			"INSERT INTO tags(message_id,type,status,session_id,tag_number,byte_size) VALUES ('real:p0','message','active',?,9,0)",
		).run(sessionId);
		db.prepare(
			"INSERT INTO source_contents(tag_id,session_id,content,created_at,harness) VALUES (9,?,?,0,'pi')",
		).run(sessionId, textOf(original));
		// Session unload discards process-local evidence, but preserves the SQLite rows.
		clearContextHandlerSession(sessionId);
		resetLkgSlotsForTest();
		const next = [structuredClone(original)];
		const result = await install()(
			{ messages: next },
			fakeContext(sessionId, process.cwd(), ["real"], next),
		);
		expect(textOf(result.messages[0])).toBe(textOf(first.messages[0]));
	} finally {
		publication.restore();
		clearContextHandlerSession(sessionId);
		resetLkgSlotsForTest();
		db.close();
	}
});
