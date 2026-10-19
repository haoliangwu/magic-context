import { expect, spyOn, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
	readReplayEnvelope,
	updateReplayDocument,
} from "@magic-context/core/features/magic-context/storage-replay-document";
import * as persistence from "@magic-context/core/hooks/magic-context/lkg-persist";
import {
	dropSlot,
	getInMemorySlot,
	resetLkgSlotsForTest,
} from "@magic-context/core/hooks/magic-context/lkg-slot";
import { createTestTempDir } from "../../plugin/src/shared/test-temp-dir";
import {
	clearContextHandlerSession,
	registerPiContextHandler,
} from "./context-handler";
import { createPiLkgCoordinator } from "./pi-lkg";
import {
	publishPiServedNumbers,
	readPiCommittedServedNumbers,
} from "./pi-served-identities";
import { readPiIdentityRebuilds } from "./pi-tag-identity-repair";
import { observePiPublicationForTest } from "./publication-observer-fixture.test";
import {
	capturePiServedArray,
	flushPiServedArrayLedger,
	getPiServedArrayLedgerPath,
	getPiServedTagNumbers,
	getPiServedTagNumbersPath,
} from "./served-array-ledger";
import {
	createFakePi,
	createTestDb,
	fakeContext,
	userMessage,
} from "./test-utils.test";

let fixtureSequence = 0;
async function fixture(
	run: (
		db: ReturnType<typeof createTestDb>,
		sessionId: string,
		root: string,
	) => void | Promise<void>,
) {
	const { dir: root, cleanup } = createTestTempDir("pi-pair-publication-");
	const dataHome = process.env.XDG_DATA_HOME;
	const configHome = process.env.XDG_CONFIG_HOME;
	process.env.XDG_DATA_HOME = root;
	process.env.XDG_CONFIG_HOME = root;
	const db = createTestDb(join(root, "context.db"));
	const sessionId = `pi-pair-publication-${fixtureSequence++}`;
	try {
		await run(db, sessionId, root);
	} finally {
		flushPiServedArrayLedger();
		clearContextHandlerSession(sessionId);
		resetLkgSlotsForTest();
		db.close();
		if (dataHome === undefined) delete process.env.XDG_DATA_HOME;
		else process.env.XDG_DATA_HOME = dataHome;
		if (configHome === undefined) delete process.env.XDG_CONFIG_HOME;
		else process.env.XDG_CONFIG_HOME = configHome;
		cleanup();
	}
}

function capture(db: ReturnType<typeof createTestDb>, sessionId: string) {
	const coordinator = createPiLkgCoordinator(db, () => {
		throw new Error("managed publication must not defer");
	});
	const raw = [userMessage("input", 1)];
	return (
		text: string,
		numbers: number[],
		publish = () => publishPiServedNumbers(db, sessionId, numbers),
	) =>
		coordinator.captureAppliedPass({
			snapshot: coordinator.beginPass({
				sessionId,
				messages: raw,
				entryIds: ["entry-1"],
				modelKey: null,
				providerKey: null,
			}),
			outputMessages: [userMessage(text, 1)],
			outputEntryIds: ["entry-1"],
			cacheBusting: false,
			publishServedNumbers: publish,
		});
}

test("LKG and served identities roll back together when metadata publication fails", async () => {
	await fixture((db, sessionId) => {
		const publish = capture(db, sessionId);
		publish("§1§ accepted", [1]);
		const before = persistence.loadPersistedLkgSlot(db, sessionId)?.jsonPrefix;
		expect(() =>
			publish("§2§ rejected", [2], () => {
				publishPiServedNumbers(db, sessionId, [2]);
				throw new Error("storage failure after identity update");
			}),
		).toThrow("Pi LKG/served publication failed");
		expect(readPiCommittedServedNumbers(db, sessionId)).toEqual([1]);
		expect(persistence.loadPersistedLkgSlot(db, sessionId)?.jsonPrefix).toBe(
			before,
		);
		expect(getInMemorySlot(sessionId)?.jsonPrefix).toBe(before);
	});
});

test("managed LKG serialization failure publishes no identities", async () => {
	await fixture((db, sessionId) => {
		const coordinator = createPiLkgCoordinator(db);
		const raw = [userMessage("input", 1)];
		expect(() =>
			coordinator.captureAppliedPass({
				snapshot: coordinator.beginPass({
					sessionId,
					messages: raw,
					entryIds: ["entry-1"],
					modelKey: null,
					providerKey: null,
				}),
				outputMessages: [
					{
						toJSON() {
							throw new Error("cannot serialize request");
						},
					},
				],
				cacheBusting: false,
				publishServedNumbers: () => publishPiServedNumbers(db, sessionId, [1]),
			}),
		).toThrow("cannot serialize request");
		expect(readPiCommittedServedNumbers(db, sessionId)).toEqual([]);
		expect(persistence.loadPersistedLkgSlot(db, sessionId)).toBeUndefined();
		expect(getInMemorySlot(sessionId)).toBeUndefined();
	});
});

test("committed identities union legacy JSONL and survive LKG invalidation without erasing replay namespaces", async () => {
	await fixture((db, sessionId) => {
		capturePiServedArray(sessionId, [userMessage("legacy", 1)], {
			servedTagNumbers: [9],
		});
		expect(
			updateReplayDocument(db, sessionId, (doc) => {
				doc.version = 2;
				doc.piNative = { sentinel: "native state" };
				doc.trailingBlank = { assistant: "strip" };
				return true;
			}),
		).toBe(true);
		capture(db, sessionId)("§1§ current", [1]);
		expect([...getPiServedTagNumbers(sessionId, undefined, db)]).toEqual([
			9, 1,
		]);
		dropSlot(sessionId, "test history removal");
		clearContextHandlerSession(sessionId);
		expect([...getPiServedTagNumbers(sessionId, undefined, db)]).toEqual([
			9, 1,
		]);
		expect(readReplayEnvelope(db, sessionId).piNative).toEqual({
			sentinel: "native state",
		});
		expect(readReplayEnvelope(db, sessionId).trailingBlank).toEqual({
			assistant: "strip",
		});
	});
});

for (const failure of ["db-save", "late-commit"] as const) {
	test(
		failure === "late-commit"
			? "real managed handler refuses late-commit without late served evidence"
			: "real managed handler serves pair-save failure without publishing evidence",
		async () => {
			await fixture(async (db, sessionId, root) => {
				const fake = createFakePi();
				registerPiContextHandler(fake.pi as never, { db });
				const handler = fake.handlers.get("context");
				if (!handler) throw new Error("context handler missing");
				const raw = [userMessage("pair before dispatch", 1)];
				const ctx = fakeContext(sessionId, root, ["entry-1"], raw);
				let now = 0;
				const clock = spyOn(performance, "now").mockImplementation(() => now);
				const save = persistence.saveLkgSlotToDb;
				const publication = observePiPublicationForTest(sessionId);
				const saver = spyOn(persistence, "saveLkgSlotToDb").mockImplementation(
					(...args) => {
						const committed = save(...args);
						if (failure === "late-commit") now = 26_000;
						return committed;
					},
				);
				if (failure === "db-save")
					db.exec(
						"CREATE TRIGGER reject_lkg BEFORE INSERT ON lkg_slots BEGIN SELECT RAISE(ABORT, 'fixture storage failure'); END",
					);
				try {
					const pending = handler({ messages: raw } as never, ctx as never);
					if (failure === "late-commit")
						await expect(pending).rejects.toThrow(
							"stage=LKG/served publication elapsed=26000ms",
						);
					else {
						const served = (await pending) as { messages: unknown[] };
						expect(JSON.stringify(served.messages)).toContain(
							"§1§ pair before dispatch",
						);
						publication.expect("commit_failed", "pair_commit_failed", 1, 1);
					}
					expect(saver).toHaveBeenCalledTimes(1);
					flushPiServedArrayLedger();
					expect(getInMemorySlot(sessionId)).toBeUndefined();
					expect(existsSync(getPiServedTagNumbersPath(sessionId))).toBe(false);
					expect(existsSync(getPiServedArrayLedgerPath(sessionId))).toBe(false);
					if (failure === "late-commit") {
						const durable = persistence.loadPersistedLkgSlot(db, sessionId);
						expect(durable?.jsonPrefix).toContain("§1§ pair before dispatch");
						expect(readPiCommittedServedNumbers(db, sessionId)).toEqual([1]);
					} else {
						expect(
							persistence.loadPersistedLkgSlot(db, sessionId),
						).toBeUndefined();
						expect(readPiCommittedServedNumbers(db, sessionId)).toEqual([]);
					}
				} finally {
					saver.mockRestore();
					publication.restore();
					clock.mockRestore();
				}
			});
		},
	);
}

for (const limitation of [
	"branch-unavailable",
	"identical-unsaved-twins",
] as const) {
	test(`serves recurring ${limitation} captures and records admitted numbers only`, async () => {
		await fixture(async (db, sessionId, root) => {
			const fake = createFakePi();
			registerPiContextHandler(fake.pi as never, { db });
			const handler = fake.handlers.get("context");
			if (!handler) throw new Error("context handler missing");
			const hello = userMessage("known entry", 2);
			const raw =
				limitation === "branch-unavailable"
					? [userMessage("unmapped entry", 1)]
					: [
							userMessage("unsaved twin", 1),
							userMessage("unsaved twin", 1),
							hello,
						];
			const ctx = fakeContext(sessionId, root, ["known"], [hello]);
			if (limitation === "branch-unavailable")
				ctx.sessionManager.getBranch = () => {
					throw new Error("branch unavailable");
				};
			const publication = observePiPublicationForTest(sessionId);
			try {
				const wires: string[] = [];
				for (let pass = 0; pass < 3; pass++) {
					const served = (await handler(
						{ messages: structuredClone(raw) } as never,
						ctx as never,
					)) as { messages: unknown[] };
					wires.push(JSON.stringify(served.messages));
				}
				expect(wires.every((wire) => wire === wires[0])).toBe(true);
				expect(wires[0]).toContain("§1§");
				const expectedNumbers =
					limitation === "branch-unavailable" ? [1] : [1, 2, 3];
				expect(readPiCommittedServedNumbers(db, sessionId)).toEqual(
					expectedNumbers,
				);
				expect([...getPiServedTagNumbers(sessionId)]).toEqual(expectedNumbers);
				expect(persistence.loadPersistedLkgSlot(db, sessionId)).toBeUndefined();
				expect(getInMemorySlot(sessionId)).toBeUndefined();
				publication.expect(
					"numbers_only",
					limitation === "branch-unavailable"
						? "lkg_entry_ids_unavailable"
						: "lkg_duplicate_entry_id",
					3,
				);
			} finally {
				publication.restore();
			}
		});
	});
}

test("number-only write failure serves without publishing and counts every failed pass", async () => {
	await fixture(async (db, sessionId, root) => {
		const fake = createFakePi();
		registerPiContextHandler(fake.pi as never, { db });
		const handler = fake.handlers.get("context");
		if (!handler) throw new Error("context handler missing");
		const raw = [userMessage("servable without evidence", 1)];
		const ctx = fakeContext(sessionId, root);
		ctx.sessionManager.getBranch = () => {
			throw new Error("branch unavailable");
		};
		db.exec(
			`CREATE TRIGGER reject_number_evidence BEFORE UPDATE OF trailing_blank_decisions ON session_meta WHEN instr(NEW.trailing_blank_decisions, '"piServedTagNumbers"') > 0 BEGIN SELECT RAISE(ABORT, 'fixture evidence IO failure'); END`,
		);
		const publication = observePiPublicationForTest(sessionId);
		try {
			for (let pass = 0; pass < 3; pass++) {
				const served = (await handler(
					{ messages: structuredClone(raw) } as never,
					ctx as never,
				)) as { messages: unknown[] };
				expect(JSON.stringify(served.messages)).toContain(
					"§1§ servable without evidence",
				);
			}
			expect(readPiCommittedServedNumbers(db, sessionId)).toEqual([]);
			expect(persistence.loadPersistedLkgSlot(db, sessionId)).toBeUndefined();
			expect(getInMemorySlot(sessionId)).toBeUndefined();
			expect(existsSync(getPiServedTagNumbersPath(sessionId))).toBe(false);
			publication.expect("commit_failed", "number_write_failed", 3);
		} finally {
			publication.restore();
		}
	});
});

for (const envelope of [
	"{",
	JSON.stringify({ version: 3, trailingBlank: {}, future: "preserve" }),
	JSON.stringify({
		version: 2,
		trailingBlank: {},
		piServedTagNumbers: "invalid",
	}),
]) {
	test(`unreadable publication envelope serves without writing: ${envelope}`, async () => {
		await fixture(async (db, sessionId, root) => {
			expect(updateReplayDocument(db, sessionId, () => false)).toBe(true);
			db.prepare(
				"UPDATE session_meta SET trailing_blank_decisions = ? WHERE session_id = ?",
			).run(envelope, sessionId);
			const fake = createFakePi();
			registerPiContextHandler(fake.pi as never, { db });
			const handler = fake.handlers.get("context");
			if (!handler) throw new Error("context handler missing");
			const raw = [userMessage("serve but preserve envelope", 1)];
			const ctx = fakeContext(sessionId, root, ["entry"], raw);
			const publication = observePiPublicationForTest(sessionId);
			try {
				for (let pass = 0; pass < 3; pass++) {
					const served = (await handler(
						{ messages: structuredClone(raw) } as never,
						ctx as never,
					)) as { messages: unknown[] };
					expect(JSON.stringify(served.messages)).toContain(
						"§1§ serve but preserve envelope",
					);
				}
				expect(
					db
						.prepare(
							"SELECT trailing_blank_decisions FROM session_meta WHERE session_id = ?",
						)
						.get(sessionId),
				).toEqual({ trailing_blank_decisions: envelope });
				expect(
					db
						.prepare("SELECT session_id FROM lkg_slots WHERE session_id = ?")
						.get(sessionId) ?? undefined,
				).toBeUndefined();
				expect(getInMemorySlot(sessionId)).toBeUndefined();
				expect([...getPiServedTagNumbers(sessionId, undefined, db)]).toEqual(
					[],
				);
				expect(existsSync(getPiServedTagNumbersPath(sessionId))).toBe(false);
				publication.expect("skipped", "envelope_unreadable", 3);
			} finally {
				publication.restore();
			}
		});
	});
}

test("unpaired envelope-conflict repairs once and keeps serving", async () => {
	await fixture(async (db, sessionId, root) => {
		expect(updateReplayDocument(db, sessionId, () => false)).toBe(true);
		db.prepare(
			"UPDATE session_meta SET trailing_blank_decisions = '{' WHERE session_id = ?",
		).run(sessionId);
		const fake = createFakePi();
		registerPiContextHandler(fake.pi as never, { db });
		const handler = fake.handlers.get("context");
		if (!handler) throw new Error("context handler missing");
		const raw = [userMessage("unpaired identity", 1)];
		const unknown = fakeContext(sessionId, root);
		unknown.sessionManager.getBranch = () => {
			throw new Error("branch unavailable");
		};
		const publication = observePiPublicationForTest(sessionId);
		try {
			const first = (await handler(
				{ messages: structuredClone(raw) } as never,
				unknown as never,
			)) as { messages: unknown[] };
			expect(JSON.stringify(first.messages)).toContain("§1§ unpaired identity");
			db.prepare(
				"INSERT INTO tags(message_id,type,status,session_id,tag_number,byte_size) VALUES ('real:p0','message','active',?,9,0)",
			).run(sessionId);
			db.prepare(
				"INSERT INTO source_contents(tag_id,session_id,content,created_at,harness) VALUES (9,?,'unpaired identity',0,'pi')",
			).run(sessionId);
			const real = fakeContext(sessionId, root, ["real"], raw);
			const repairs: unknown[] = [];
			const wires: string[] = [];
			for (let pass = 0; pass < 3; pass++) {
				const served = (await handler(
					{ messages: structuredClone(raw) } as never,
					real as never,
				)) as { messages: unknown[] };
				wires.push(JSON.stringify(served.messages));
				repairs.push(readPiIdentityRebuilds(db, sessionId));
			}
			expect(wires.every((wire) => wire === wires[0])).toBe(true);
			expect(wires[0]).toContain("§9§ unpaired identity");
			expect(repairs[0]).toHaveLength(1);
			expect(repairs[1]).toEqual(repairs[0]);
			expect(repairs[2]).toEqual(repairs[0]);
			expect(
				db
					.prepare("SELECT session_id FROM lkg_slots WHERE session_id = ?")
					.get(sessionId) ?? undefined,
			).toBeUndefined();
			expect(existsSync(getPiServedTagNumbersPath(sessionId))).toBe(false);
			publication.expect("skipped", "envelope_unreadable", 4);
		} finally {
			publication.restore();
		}
	});
});
