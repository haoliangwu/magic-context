import { expect, it } from "bun:test";
import { join } from "node:path";
import { getTemporalDecisions } from "@magic-context/core/features/magic-context/temporal-decisions";
import { resetLkgSlotsForTest } from "@magic-context/core/hooks/magic-context/lkg-slot";
import { seedTemporalUpgradeFixture } from "@magic-context/core/shared/temporal-upgrade-fixture";
import { createTestTempDir } from "@magic-context/core/shared/test-temp-dir";
import {
	clearContextHandlerSession,
	registerPiContextHandler,
} from "./context-handler";
import {
	createFakePi,
	createTestDb,
	fakeContext,
	type PiMessage,
	textOf,
} from "./test-utils.test";

it("Pi upgrade preserves every previously served marker on the first defer", async () => {
	const root = createTestTempDir("pi-temporal-upgrade-");
	const dbPath = join(root.dir, "context.db");
	let db = createTestDb(dbPath);
	const captured = seedTemporalUpgradeFixture(db, "Pi");
	const sessionId = captured.sessionId;
	try {
		if (!captured.cwd || !captured.entryIds)
			throw new Error("Pi fixture lacks its captured context");
		expect(captured.projectionJson).toContain("<!-- +5m -->");
		expect(captured.projectionJson).toContain("<!-- +10m -->");
		expect(getTemporalDecisions(db, sessionId).size).toBe(0);
		const prefix = db
			.prepare(
				"SELECT cached_m0_bytes, cached_m1_bytes FROM session_meta WHERE session_id=?",
			)
			.get(sessionId);
		db.close();
		db = createTestDb(dbPath);
		const next = createFakePi();
		registerPiContextHandler(next.pi as never, {
			db,
			protectedTags: 0,
			heuristics: {},
			injection: { injectionBudgetTokens: 10_000, temporalAwareness: true },
		});
		const continued = structuredClone(captured.input);
		const handler = next.handlers.get("context") as (
			event: { messages: unknown[] },
			ctx: unknown,
		) => Promise<{ messages: unknown[] }>;
		const replay = await handler(
			{ messages: continued },
			fakeContext(
				sessionId,
				captured.cwd,
				captured.entryIds,
				continued as never,
			),
		);
		expect(JSON.stringify(replay.messages)).toBe(captured.projectionJson);
		expect(
			db
				.prepare(
					"SELECT cached_m0_bytes, cached_m1_bytes FROM session_meta WHERE session_id=?",
				)
				.get(sessionId),
		).toEqual(prefix);
		expect(getTemporalDecisions(db, sessionId).get("user")).toBe(
			"<!-- +5m -->\n",
		);
		expect(getTemporalDecisions(db, sessionId).get("later")).toBe(
			"<!-- +10m -->\n",
		);
	} finally {
		clearContextHandlerSession(sessionId);
		db.close();
		root.cleanup();
	}
});

async function legacyPiCut(keepLkg: boolean): Promise<void> {
	const root = createTestTempDir("temporal-re-review-pi-");
	const path = join(root.dir, "context.db");
	let db = createTestDb(path);
	resetLkgSlotsForTest();
	const captured = seedTemporalUpgradeFixture(db, "Pi");
	const id = captured.sessionId;
	try {
		if (!captured.cwd || !captured.entryIds)
			throw new Error("Pi fixture lacks its captured context");
		expect(getTemporalDecisions(db, id).size).toBe(0);
		if (!keepLkg) {
			db.prepare("DELETE FROM lkg_slot_chunks WHERE session_id=?").run(id);
			db.prepare("DELETE FROM lkg_slots WHERE session_id=?").run(id);
		}
		const cache = db
			.prepare(
				"SELECT cached_m0_bytes,cached_m1_bytes FROM session_meta WHERE session_id=?",
			)
			.get(id);
		db.close();
		db = createTestDb(path);
		const fake = createFakePi();
		registerPiContextHandler(fake.pi as never, {
			db,
			protectedTags: 0,
			heuristics: {},
			injection: { injectionBudgetTokens: 10_000, temporalAwareness: true },
		});
		const messages = structuredClone(captured.input.slice(1)) as PiMessage[];
		const handler = fake.handlers.get("context") as (
			event: { messages: PiMessage[] },
			ctx: unknown,
		) => Promise<{ messages: PiMessage[] }>;
		const output = await handler(
			{ messages },
			fakeContext(id, captured.cwd, captured.entryIds.slice(1), messages),
		);
		expect(
			db
				.prepare(
					"SELECT cached_m0_bytes,cached_m1_bytes FROM session_meta WHERE session_id=?",
				)
				.get(id),
		).toEqual(cache);
		expect(
			output.messages.map(textOf).filter((text) => /^§[23]§/.test(text)),
		).toEqual(["§2§ <!-- +5m -->\nquestion", "§3§ <!-- +10m -->\nfollow up"]);
		expect(getTemporalDecisions(db, id).get("user")).toBe("<!-- +5m -->\n");
	} finally {
		clearContextHandlerSession(id);
		resetLkgSlotsForTest();
		db.close();
		root.cleanup();
	}
}

it("control: Pi cut-seam upgrade prefers the exact LKG over the empty neighbour candidate", () =>
	legacyPiCut(true));
it("Pi cut-seam upgrade without LKG preserves the source-backed previously served marker", () =>
	legacyPiCut(false));
