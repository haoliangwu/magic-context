import { afterEach, expect, spyOn, test } from "bun:test";
import * as syncFs from "node:fs";
import { readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readRetrospectiveScanWindow } from "@magic-context/core/features/magic-context/dreamer/retrospective-raw-provider";
import { createTestTempDirFromPath } from "../../../plugin/src/shared/test-temp-dir";
import { asyncSessionEntries, sessionEntries } from "./bounded-session-reader";
import { createPiPrimerRawProviderFactory } from "./primer-raw-provider-pi";
import { PiRetrospectiveRawProvider } from "./retrospective-raw-provider-pi";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0))
		rmSync(dir, { recursive: true, force: true });
});
function directory() {
	const dir = createTestTempDirFromPath(join(tmpdir(), "pi-retro-async-"));
	dirs.push(dir);
	return dir;
}
function user(
	id: string,
	timestamp: number,
	content: unknown,
	parentId: string | null = null,
) {
	return {
		type: "message",
		id,
		parentId,
		message: { role: "user", timestamp, content },
	};
}
function store(dir: string, id: string, entries: unknown[], extra = {}) {
	const path = join(dir, `${id}.jsonl`);
	writeFileSync(
		path,
		[
			JSON.stringify({
				type: "session",
				version: 3,
				id,
				cwd: "/fixture",
				...extra,
			}),
			...entries.map((e) => (typeof e === "string" ? e : JSON.stringify(e))),
		].join("\r\n"),
	);
	return path;
}

// The former whole-file loader is independent of the asynchronous line decoder.
function legacyEntries(path: string): unknown[] {
	return readFileSync(path, "utf8")
		.split("\n")
		.flatMap((line) => {
			try {
				return [JSON.parse(line)];
			} catch {
				return [];
			}
		});
}

test("generated imported and branched sessions retain every retrospective selection", async () => {
	const dir = directory();
	const padding = "x".repeat(16_384);
	for (let s = 0; s < 32; s++) {
		const entries: unknown[] = [];
		for (let i = 0; i < 65; i++) {
			entries.push({
				type: "message",
				id: `tool-${i}`,
				message: { role: "toolResult", content: padding },
			});
			entries.push(
				user(
					`u-${i}`,
					100 + ((i * 17 + s) % 41),
					[
						{ type: "text", text: `  question ${s}/${i} café 🐈  ` },
						{ type: "image", data: "ignored" },
						{ type: "text", text: "second line" },
					],
					i % 3 ? `u-${i - 1}` : "fork-parent",
				),
			);
			if (i % 11 === 0)
				entries.push("malformed", "", {
					type: "branch_summary",
					id: `branch-${i}`,
				});
		}
		entries.push(
			user("empty", 130, "  "),
			user("equal", 120, "equal timestamp"),
		);
		store(dir, `s-${s}`, entries, {
			parentSession: s % 2 ? "imported.jsonl" : undefined,
		});
	}
	store(dir, "foreign", [user("foreign", 120, "foreign")], { cwd: "/other" });
	writeFileSync(join(dir, "bad.jsonl"), "not a session header\n");
	const current = new PiRetrospectiveRawProvider({
		sessionDir: dir,
		projectCwd: "/fixture",
	});
	const legacy = new PiRetrospectiveRawProvider({
		sessionDir: dir,
		projectCwd: "/fixture",
		loadEntriesFromFile: legacyEntries,
	});
	const sessions = await current.listProjectSessions("fixture");
	expect(sessions).toEqual(await legacy.listProjectSessions("fixture"));
	expect(sessions).toHaveLength(32);
	for (const since of [99, 120, 141]) {
		expect(
			await current.readOldestMessageTimesSince(
				sessions.map((s) => s.sessionId),
				since,
			),
		).toEqual(
			await legacy.readOldestMessageTimesSince(
				sessions.map((s) => s.sessionId),
				since,
			),
		);
		for (const session of sessions.slice(0, 3)) {
			for (const count of [1, 7, 100]) {
				expect(
					await current.readUserMessagesSince(session.sessionId, since, count),
				).toEqual(
					await legacy.readUserMessagesSince(session.sessionId, since, count),
				);
				expect(
					await current.readUserMessagesBefore(session.sessionId, since, count),
				).toEqual(
					await legacy.readUserMessagesBefore(session.sessionId, since, count),
				);
			}
		}
		expect(
			await readRetrospectiveScanWindow(current, "fixture", since, 3, {
				maxSessionsPerRun: 4,
				capPerSession: 7,
			}),
		).toEqual(
			await readRetrospectiveScanWindow(legacy, "fixture", since, 3, {
				maxSessionsPerRun: 4,
				capPerSession: 7,
			}),
		);
	}
}, 30_000);

test("async decoder preserves bounded oversized stubs, ordinals and UTF-8 chunk boundaries", async () => {
	const dir = directory();
	const path = store(dir, "s", [
		user("unicode", 10, "é🐈".repeat(40_000)),
		user("oversize", 20, "x".repeat(2 * 1024 * 1024)),
		"malformed",
		user("last", 5, "last"),
	]);
	const actual: unknown[] = [];
	for await (const entry of asyncSessionEntries(path)) actual.push(entry);
	expect(actual).toEqual([...sessionEntries(path)]);
	expect(actual).toHaveLength(4);
});

test("since queries skip older mtimes without opening them, but before and equality still read", async () => {
	const dir = directory();
	const old = store(dir, "old", [user("u", 900, "old")]);
	const equal = store(dir, "equal", [
		user("u", 1000, "boundary"),
		user("v", 800, "nonmonotonic"),
	]);
	utimesSync(old, 1, 1);
	utimesSync(equal, 1, 1);
	const provider = new PiRetrospectiveRawProvider({
		sessionDir: dir,
		projectCwd: "/fixture",
	});
	await provider.listProjectSessions("fixture");
	const opened = spyOn(fs, "open");
	try {
		expect(
			await provider.readOldestMessageTimesSince(["old", "equal"], 1001),
		).toEqual(new Map());
		expect(await provider.readUserMessagesSince("old", 1001, 10)).toEqual({
			messages: [],
			truncated: false,
		});
		expect(opened).not.toHaveBeenCalled();
		expect(
			(await provider.readUserMessagesBefore("old", 1001, 10)).map(
				(m) => m.text,
			),
		).toEqual(["old"]);
		expect(
			(await provider.readUserMessagesSince("equal", 999, 10)).messages.map(
				(m) => m.text,
			),
		).toEqual(["boundary"]);
		expect(
			(await provider.readUserMessagesSince("equal", 1000, 10)).messages,
		).toEqual([]);
		expect(opened).toHaveBeenCalledTimes(3);
	} finally {
		opened.mockRestore();
	}
});

test("retrospective and primer history yield to host timers during real file traversal", async () => {
	const dir = directory();
	const padding = {
		type: "message",
		id: "tool",
		message: { role: "toolResult", content: "x".repeat(16_384) },
	};
	store(dir, "s", [...Array(512).fill(padding), user("last", 10, "last")]);
	const provider = new PiRetrospectiveRawProvider({
		sessionDir: dir,
		projectCwd: "/fixture",
	});
	await provider.listProjectSessions("fixture");
	let timerRan = false;
	const syncRead = spyOn(syncFs, "readSync");
	const syncReadFile = spyOn(syncFs, "readFileSync");
	const timer = setTimeout(() => {
		timerRan = true;
	}, 0);
	try {
		expect(await provider.readOldestMessageTimesSince(["s"], 0)).toEqual(
			new Map([["s", 10]]),
		);
		expect(timerRan).toBe(true);
		expect(syncRead).not.toHaveBeenCalled();
		expect(syncReadFile).not.toHaveBeenCalled();
	} finally {
		clearTimeout(timer);
		syncRead.mockRestore();
		syncReadFile.mockRestore();
	}
	const primer = await createPiPrimerRawProviderFactory({ sessionDir: dir })(
		"s",
	);
	if (!primer?.iterateMessageRangeAsync)
		throw new Error("Missing async primer traversal");
	timerRan = false;
	const primerTimer = setTimeout(() => {
		timerRan = true;
	}, 0);
	try {
		const rows = [];
		for await (const row of primer.iterateMessageRangeAsync(1, 100))
			rows.push(row);
		expect(rows.map((r) => r.id)).toEqual(["last"]);
		expect(timerRan).toBe(true);
	} finally {
		clearTimeout(primerTimer);
	}
});
