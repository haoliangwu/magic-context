import { afterAll, afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as embedding from "@magic-context/core/features/magic-context/memory/embedding";
import { getAutoSearchHintDecisions } from "@magic-context/core/features/magic-context/storage-meta-persisted";
import {
	deadlineClock,
	nextLoopTurn,
} from "@magic-context/core/hooks/magic-context/auto-search-clock.test";
import { persistAutoSearchSkip } from "@magic-context/core/hooks/magic-context/auto-search-deadline";
import { autoSearchTestSnapshot } from "@magic-context/core/hooks/magic-context/auto-search-snapshot.fixture";
import * as search from "@magic-context/core/hooks/magic-context/auto-search-worker-client";
import { searchAutoHint } from "@magic-context/core/hooks/magic-context/auto-search-worker-client";
import { createTestTempDirFromPath } from "@magic-context/core/shared/test-temp-dir";
import { runAutoSearchHintForPi } from "./auto-search-pi";
import { createTestDb, userMessage } from "./test-utils.test";

const root = join(tmpdir(), "magic-context", "auto-search-deadline");
mkdirSync(root, { recursive: true });
const db = createTestDb(
	join(createTestTempDirFromPath(join(root, "pi-")), "context.db"),
);
const options = {
	enabled: true,
	scoreThreshold: 0.6,
	projectPath: "git:pi-deadline",
	minPromptChars: 1,
};
let snapshotSpy: ReturnType<
	typeof spyOn<typeof embedding, "getProjectEmbeddingSnapshot">
>;
beforeEach(() => {
	snapshotSpy = spyOn(embedding, "getProjectEmbeddingSnapshot").mockReturnValue(
		autoSearchTestSnapshot(options.projectPath),
	);
});
afterEach(() => snapshotSpy.mockRestore());
afterAll(() => db.close());

test("Pi aborts slow embeddings at the deadline and replays byte-identical skip on retry", async () => {
	const clock = deadlineClock();
	const entered = Promise.withResolvers<void>();
	let signal: AbortSignal | undefined;
	let release: ((value: null) => void) | undefined;
	const spy = spyOn(embedding, "embedTextForProject").mockImplementation(
		async (_project, _text, current) => {
			signal = current;
			return new Promise<null>((resolve) => {
				release = resolve;
				entered.resolve();
			});
		},
	);
	try {
		const messages = [userMessage("explain historian cache wiring", 1)];
		const before = JSON.stringify(messages);
		const pending = runAutoSearchHintForPi({
			db,
			sessionId: "pi-slow",
			messages,
			entryIds: ["user"],
			options,
		});
		await entered.promise;
		expect(signal?.aborted).toBe(false);
		clock.expire();
		await pending;
		expect(signal?.aborted).toBe(true);
		expect(JSON.stringify(messages)).toBe(before);
		release?.(null);
		await persistAutoSearchSkip(db, "pi-slow", "user");
		expect(getAutoSearchHintDecisions(db, "pi-slow")[0]).toEqual({
			messageId: "user",
			decision: "no-hint",
			reason: "timeout",
		});
		expect(
			db
				.prepare("SELECT harness FROM session_meta WHERE session_id = ?")
				.get("pi-slow"),
		).toEqual({ harness: "pi" });
		const replay = [userMessage("explain historian cache wiring", 1)];
		await runAutoSearchHintForPi({
			db,
			sessionId: "pi-slow",
			messages: replay,
			entryIds: ["user"],
			options,
		});
		expect(JSON.stringify(replay)).toBe(before);
		expect(spy).toHaveBeenCalledTimes(1);
	} finally {
		release?.(null);
		spy.mockRestore();
		clock.restore();
	}
}, 6000);

test("Pi bounds a synchronous SQLite search worker by the same turn deadline", async () => {
	const clock = deadlineClock();
	let searchSignal: AbortSignal | undefined;
	const workerEntered = Promise.withResolvers<void>();
	const realSearch = searchAutoHint;
	const spy = spyOn(search, "searchAutoHint").mockImplementation(
		(db, session, project, query, options) => {
			searchSignal = options.signal;
			return realSearch(
				db,
				session,
				project,
				query,
				options,
				new URL(
					"../../plugin/src/hooks/magic-context/auto-search-blocking.fixture.ts",
					import.meta.url,
				),
			);
		},
	);
	const embed = spyOn(embedding, "embedTextForProject").mockImplementation(
		async (_project, text) => {
			if (text === "synchronous-fixture-entered") workerEntered.resolve();
			return null;
		},
	);
	try {
		const messages = [userMessage("explain historian cache wiring", 1)];
		const before = JSON.stringify(messages);
		let served = false;
		const pending = runAutoSearchHintForPi({
			db,
			sessionId: "pi-sync",
			messages,
			entryIds: ["user"],
			options,
		}).then(() => {
			served = true;
		});
		await workerEntered.promise;
		await nextLoopTurn();
		expect(served).toBe(false);
		clock.expire();
		expect(searchSignal?.aborted).toBe(true);
		await pending;
		expect(embed).toHaveBeenCalledTimes(1);
		expect(JSON.stringify(messages)).toBe(before);
	} finally {
		spy.mockRestore();
		embed.mockRestore();
		clock.restore();
	}
}, 6000);

test("Pi defers cold synchronous preparation without holding the served stage", async () => {
	snapshotSpy.mockReturnValue(null);
	let prepared = false;
	const preparation = Promise.withResolvers<void>();
	const messages = [userMessage("explain historian cache wiring", 1)];
	const before = JSON.stringify(messages);
	await runAutoSearchHintForPi({
		db,
		sessionId: "pi-cold-preparation",
		messages,
		entryIds: ["cold-user"],
		options,
		ensureProjectRegistered: async () => {
			prepared = true;
			preparation.resolve();
		},
	});
	expect(prepared).toBe(false);
	expect(JSON.stringify(messages)).toBe(before);
	await preparation.promise;
	expect(prepared).toBe(true);
}, 7000);
