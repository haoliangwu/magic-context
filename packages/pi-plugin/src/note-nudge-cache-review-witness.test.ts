import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { __resetMessageIndexAsyncForTests } from "@magic-context/core/features/magic-context/message-index-async";
import {
	addNote,
	appendAutoSearchHintDecision,
	getNoteNudgeAnchors,
} from "@magic-context/core/features/magic-context/storage";
import { onNoteTrigger } from "@magic-context/core/hooks/magic-context/note-nudger";
import { clearModelsDevCache } from "@magic-context/core/shared/models-dev-cache";
import type { Database } from "@magic-context/core/shared/sqlite";
import {
	cleanupTestTempDir,
	createTestTempDir,
} from "@magic-context/core/shared/test-temp-dir";
import {
	clearContextHandlerSession,
	registerPiContextHandler,
	signalPiPendingMaterialization,
} from "./context-handler";
import {
	assistantMessage,
	assistantToolCall,
	createFakePi,
	createTestDb,
	fakeContext,
	type PiMessage,
	textOf,
	toolResultMessage,
	userMessage,
} from "./test-utils.test";

const databases: Database[] = [];
const sessions: string[] = [];
const roots: string[] = [];
const oldData = process.env.XDG_DATA_HOME;
const oldCache = process.env.XDG_CACHE_HOME;
const now = 1_800_000_000_000;

afterEach(() => {
	__resetMessageIndexAsyncForTests();
	clearModelsDevCache();
	for (const session of sessions.splice(0)) clearContextHandlerSession(session);
	for (const db of databases.splice(0)) db.close();
	for (const root of roots.splice(0)) cleanupTestTempDir(root);
	if (oldData === undefined) delete process.env.XDG_DATA_HOME;
	else process.env.XDG_DATA_HOME = oldData;
	if (oldCache === undefined) delete process.env.XDG_CACHE_HOME;
	else process.env.XDG_CACHE_HOME = oldCache;
});

function fixture(sessionId: string, path = ":memory:") {
	const { dir: root } = createTestTempDir("pi-note-nudge-review-");
	roots.push(root);
	process.env.XDG_DATA_HOME = root;
	process.env.XDG_CACHE_HOME = root;
	let db = createTestDb(path);
	databases.push(db);
	sessions.push(sessionId);
	const fake = createFakePi();
	const register = () => registerPiContextHandler(fake.pi as never, { db });
	register();
	const raw: PiMessage[] = [userMessage("warm", now)];
	const ids = ["warm"];
	let percentage = 20;
	const serve = async () => {
		const messages = structuredClone(raw);
		const handler = fake.handlers.get("context") as (
			event: { messages: PiMessage[] },
			ctx: unknown,
		) => Promise<{ messages: PiMessage[] }>;
		return (
			await handler(
				{ messages },
				{
					...fakeContext(sessionId, root, ids, messages),
					model: {
						provider: "anthropic",
						id: "claude-opus-5-5",
						contextWindow: 1_000_000,
					},
					getContextUsage: () => ({
						tokens: Math.round(percentage * 1000),
						percent: percentage,
						contextWindow: 1_000_000,
					}),
				},
			)
		).messages;
	};
	return {
		get db() {
			return db;
		},
		raw,
		ids,
		serve,
		pressure: (value: number) => {
			percentage = value;
		},
		restart: (reopen = false) => {
			clearContextHandlerSession(sessionId);
			if (reopen) {
				databases.splice(databases.indexOf(db), 1);
				db.close();
				db = createTestDb(path);
				databases.push(db);
			}
			register();
		},
	};
}

describe("independent Pi note-nudge cache review", () => {
	it("legacy upgrade capture records first delivery and saved replay", async () => {
		const clock = spyOn(Date, "now").mockReturnValue(now);
		try {
			const sessionId = "pi-review-legacy-capture";
			const f = fixture(sessionId);
			await f.serve();
			f.raw.push(userMessage("legacy-anchor", now + 1));
			f.ids.push("legacy-anchor");
			appendAutoSearchHintDecision(f.db, sessionId, {
				messageId: "legacy-anchor",
				decision: "hint",
				text: "\n\n<ctx-search-hint>frozen recall</ctx-search-hint>",
			});
			addNote(f.db, "session", { sessionId, content: "Legacy capture note" });
			onNoteTrigger(f.db, sessionId, "historian_complete");
			for (let pass = 0; pass < 2; pass++) {
				const region = (await f.serve()).at(-1);
				expect(textOf(region)).toContain("deferred_notes");
				expect(textOf(region)).toContain("ctx-search-hint");
				if (process.env.NUDGE_REVIEW_OUTPUT)
					appendFileSync(
						process.env.NUDGE_REVIEW_OUTPUT,
						`${JSON.stringify({ host: "legacy-pi", seed: 0, pass, bytes: JSON.stringify(region) })}\n`,
					);
			}
		} finally {
			clock.mockRestore();
		}
	});

	for (const seed of [17, 2027, 0x5eed]) {
		it(`no-pending differential seed ${seed}: 48 passes`, async () => {
			const clock = spyOn(Date, "now").mockReturnValue(now);
			try {
				let state = seed;
				const next = () =>
					(state = (Math.imul(state, 1664525) + 1013904223) >>> 0);
				const f = fixture(`pi-review-diff-${seed}`);
				for (let pass = 0; pass < 48; pass++) {
					if (pass > 0 && pass % 4 === 0) {
						f.raw.push(userMessage(`prompt ${next()}`, now + pass));
						f.ids.push(`user-${pass}`);
					} else if (pass % 4 === 1) {
						f.raw.push(
							assistantToolCall(
								`call-${pass}`,
								"Read",
								{ filePath: `/review/${next()}` },
								now + pass,
							),
						);
						f.ids.push(`call-${pass}`);
					} else if (pass % 4 === 2) {
						f.raw.push(
							toolResultMessage(
								`call-${pass - 1}`,
								`result ${next()}`,
								now + pass,
							),
						);
						f.ids.push(`result-${pass}`);
					}
					f.pressure([20, 64, 70, 86][next() % 4]);
					const messages = await f.serve();
					const bytes = JSON.stringify(messages);
					expect(bytes).not.toContain("deferred_notes");
					expect(bytes).not.toContain("ctx-search-hint");
					expect(messages.length).toBeGreaterThan(0);
					expect(bytes).toContain("§1§");
					if (process.env.NUDGE_REVIEW_OUTPUT)
						appendFileSync(
							process.env.NUDGE_REVIEW_OUTPUT,
							`${JSON.stringify({ host: "pi", seed, pass, bytes })}\n`,
						);
					if (pass === 24) f.restart();
				}
			} finally {
				clock.mockRestore();
			}
		}, 30000);
	}

	it("pending note waits through 48 signed-loop passes and delivers on the first fresh tail", async () => {
		const { dir: root } = createTestTempDir("pi-note-nudge-review-reopen-");
		roots.push(root);
		const sessionId = "pi-review-liveness";
		const f = fixture(sessionId, join(root, "db.sqlite"));
		f.raw.push(
			assistantMessage("working", now + 1, {
				provider: "anthropic",
				model: "claude-opus-5-5",
				content: [
					{
						type: "thinking",
						thinking: "keep signed",
						thinkingSignature: "review-signature",
					},
					{ type: "text", text: "working" },
				],
			}),
		);
		f.ids.push("signed-step");
		const first = await f.serve();
		addNote(f.db, "session", {
			sessionId,
			content: "Eventually deliver on Pi",
		});
		onNoteTrigger(f.db, sessionId, "historian_complete");
		for (let pass = 0; pass < 48; pass++) {
			signalPiPendingMaterialization(sessionId);
			expect(await f.serve()).toEqual(first);
		}
		expect(getNoteNudgeAnchors(f.db, sessionId)).toHaveLength(0);
		f.raw.push(userMessage("new task", now + 2));
		f.ids.push("fresh");
		appendAutoSearchHintDecision(f.db, sessionId, {
			messageId: "fresh",
			decision: "hint",
			text: "\n\n<ctx-search-hint>saved recall</ctx-search-hint>",
		});
		const delivered = await f.serve();
		expect(delivered[0]).toEqual(first[0]);
		// A new user can remove the previous assistant's signed thinking under Pi's
		// existing cleanup policy. The old user must stay unchanged; below, compare
		// the note and hint text on the new user across replay and database reopen.
		const region = textOf(delivered.at(-1));
		expect(region).toContain("deferred_notes");
		expect(region.indexOf("deferred_notes")).toBeLessThan(
			region.indexOf("ctx-search-hint"),
		);
		for (let pass = 0; pass < 48; pass++) {
			if (pass === 24) f.restart(true);
			expect(textOf((await f.serve()).at(-1))).toBe(region);
		}
	}, 30000);
});
