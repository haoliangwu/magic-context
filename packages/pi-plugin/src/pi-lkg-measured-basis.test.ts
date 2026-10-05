import { afterEach, expect, test } from "bun:test";
import { runMigrations } from "@magic-context/core/features/magic-context/migrations";
import { initializeDatabase } from "@magic-context/core/features/magic-context/storage-db";
import { calibrationForModelKey } from "@magic-context/core/hooks/magic-context/decision-calibration";
import { resetLkgSlotsForTest } from "@magic-context/core/hooks/magic-context/lkg-slot";
import { Database } from "@magic-context/core/shared/sqlite";
import {
	clearPiLkgSessionState,
	createPiLkgCoordinator,
	notePiLkgProviderUsage,
} from "./pi-lkg";
import { readPiLkgFitEnvelope } from "./pi-lkg-fit-envelope";
import { assertPiRawFallbackFits } from "./pi-raw-fallback";

const key = "openai-codex/gpt-5.6-sol";
const databases: Database[] = [];
const sessions: string[] = [];
afterEach(() => {
	for (const session of sessions.splice(0)) clearPiLkgSessionState(session);
	resetLkgSlotsForTest();
	for (const db of databases.splice(0)) db.close();
});
function harness() {
	const db = new Database(":memory:");
	databases.push(db);
	initializeDatabase(db);
	runMigrations(db);
	const sessionId = `measured-${sessions.length}`;
	sessions.push(sessionId);
	let capture: (() => void) | undefined;
	const coordinator = createPiLkgCoordinator(db, (run) => {
		capture = run;
	});
	const envelope = readPiLkgFitEnvelope(
		{ getSystemPrompt: () => "Complete host prompt." },
		{ getAllTools: () => [] },
		key,
		calibrationForModelKey(key),
	);
	if (!envelope?.envelopeSignature)
		throw new Error("complete envelope required");
	const prefix = [
		{
			role: "user",
			timestamp: 1,
			content: [
				{
					type: "image",
					mimeType: "image/png",
					data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+yaz0AAAAASUVORK5CYII=",
				},
			],
		},
	];
	const snapshot = coordinator.beginPass({
		sessionId,
		messages: prefix,
		entryIds: ["input"],
		modelKey: key,
		providerKey: "openai-codex",
	});
	const recapture = (flush = true) => {
		coordinator.captureAppliedPass({
			snapshot,
			outputMessages: prefix,
			outputEntryIds: ["input"],
			cacheBusting: false,
			hostEnvelopeSignature: envelope.envelopeSignature,
		});
		if (!capture) throw new Error("scheduled capture required");
		if (flush) {
			capture();
			capture = undefined;
		}
	};
	recapture();
	const assistant = {
		role: "assistant",
		content: [{ type: "text", text: "Accepted reply" }],
		model: "gpt-5.6-sol",
		provider: "openai-codex",
		timestamp: Date.now() + 1,
		stopReason: "stop",
		usage: {
			input: 100,
			cacheRead: 20,
			cacheWrite: 10,
			output: 10,
			totalTokens: 140,
		},
	};
	const tail = [
		assistant,
		{ role: "user", content: "new tail", timestamp: Date.now() + 2 },
	];
	const replay = (parent = "input") =>
		coordinator.replay(
			coordinator.beginPass({
				sessionId,
				messages: [...prefix, ...tail],
				entryIds: ["input", "answer", "new-input"],
				modelKey: key,
				providerKey: "openai-codex",
			}),
			(id) => (id === "answer" ? parent : undefined),
		);
	return {
		db,
		sessionId,
		coordinator,
		envelope,
		assistant,
		tail,
		replay,
		recapture,
	};
}

test("correlated provider input includes cached tokens and prices only the appended reply and new tail", () => {
	const h = harness();
	expect(notePiLkgProviderUsage(h.sessionId, "input", h.assistant)).toBe(true);
	const replay = h.replay();
	if (!replay.ok) throw new Error(replay.reason);
	expect(replay.measuredPrefix?.inputTokens).toBe(130);
	expect(replay.measuredPrefix?.appendedMessages).toEqual(h.tail);
	const logs: string[] = [];
	// The already accepted image is measurable through provider usage, even
	// though the local full-prefix tokenizer cannot completely price images.
	expect(() =>
		assertPiRawFallbackFits(
			replay.messages,
			5000,
			(line) => logs.push(line),
			null,
			h.envelope,
			replay.measuredPrefix,
		),
	).not.toThrow();
	expect(logs.join("\n")).toContain(
		"lkg_fit_basis=provider_input measured_input=130",
	);
	expect(() =>
		assertPiRawFallbackFits(replay.messages, 5000, () => {}, null, h.envelope),
	).toThrow();
	if (!replay.measuredPrefix)
		throw new Error("correlated provider basis required");
	const tooLarge = { ...replay.measuredPrefix, inputTokens: 5001 };
	expect(() =>
		assertPiRawFallbackFits(
			replay.messages,
			5000,
			() => {},
			null,
			h.envelope,
			tooLarge,
		),
	).toThrow();
});

test("provider usage from a different model is not a captured-slot fit basis", () => {
	const h = harness();
	h.assistant.model = "different-model";
	expect(notePiLkgProviderUsage(h.sessionId, "input", h.assistant)).toBe(false);
	const replay = h.replay();
	if (!replay.ok) throw new Error(replay.reason);
	expect(replay.measuredPrefix).toBeUndefined();
	expect(() =>
		assertPiRawFallbackFits(
			replay.messages,
			5000,
			() => {},
			null,
			h.envelope,
			replay.measuredPrefix,
		),
	).toThrow();
});

test("provider usage requires the real JSONL parent and the exact captured pass", () => {
	const h = harness();
	expect(notePiLkgProviderUsage(h.sessionId, "wrong-parent", h.assistant)).toBe(
		false,
	);
	expect(notePiLkgProviderUsage(h.sessionId, "input", h.assistant)).toBe(true);
	const wrongParent = h.replay("different-parent");
	expect(wrongParent.ok && wrongParent.measuredPrefix).toBeUndefined();
	h.recapture();
	const superseded = h.replay();
	expect(superseded.ok && superseded.measuredPrefix).toBeUndefined();
});

test("changed host metadata cannot borrow the old measured prefix", () => {
	const h = harness();
	notePiLkgProviderUsage(h.sessionId, "input", h.assistant);
	const replay = h.replay();
	if (!replay.ok) throw new Error(replay.reason);
	const changed = {
		...h.envelope,
		envelopeSignature: "changed-system-or-tools",
	};
	const logs: string[] = [];
	expect(() =>
		assertPiRawFallbackFits(
			replay.messages,
			5000,
			(line) => logs.push(line),
			null,
			changed,
			replay.measuredPrefix,
		),
	).toThrow();
	expect(logs.join("\n")).toContain("lkg_fit_basis=host_metadata");
});

test("unaccepted, incomplete or older usage cannot become a measured prefix", () => {
	const h = harness();
	for (const message of [
		{ ...h.assistant, stopReason: "error" },
		{ ...h.assistant, stopReason: "aborted" },
		{ ...h.assistant, timestamp: 1 },
		{ ...h.assistant, provider: "another-provider" },
		{ ...h.assistant, usage: { input: 100 } },
	])
		expect(notePiLkgProviderUsage(h.sessionId, "input", message)).toBe(false);
});

for (const flush of [true, false]) {
	test(`unchanged capture preserves provider-measured resend without a database write (deferred commit ${flush ? "flushed" : "pending"})`, () => {
		const h = harness();
		const changes = () => h.db.prepare("SELECT total_changes() AS n").get();
		const before = changes();
		h.recapture(flush);
		h.assistant.timestamp = Date.now() + 1;
		expect(notePiLkgProviderUsage(h.sessionId, "input", h.assistant)).toBe(
			true,
		);
		const replay = h.replay();
		if (!replay.ok) throw new Error(replay.reason);
		expect(replay.measuredPrefix?.inputTokens).toBe(130);
		expect(() =>
			assertPiRawFallbackFits(
				replay.messages,
				5000,
				() => {},
				null,
				h.envelope,
				replay.measuredPrefix,
			),
		).not.toThrow();
		expect(changes()).toEqual(before);
	});
}
