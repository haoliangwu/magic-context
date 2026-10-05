/// <reference types="bun-types" />

import { describe, expect, it } from "bun:test";
import {
	RETROSPECTIVE_MAX_USER_MESSAGE_CHARS,
	readRetrospectiveScanWindow,
} from "@magic-context/core/features/magic-context/dreamer/retrospective-raw-provider";
import { advanceSessionActivity } from "@magic-context/core/features/magic-context/session-activity";
import { Database } from "@magic-context/core/shared/sqlite";
import { PiRetrospectiveRawProvider } from "./retrospective-raw-provider-pi";

describe("PiRetrospectiveRawProvider", () => {
	it("uses entry activity rather than file modified time when context.db is available", async () => {
		const db = new Database(":memory:");
		try {
			db.exec(
				"CREATE TABLE schema_migrations_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
			);
			advanceSessionActivity(db, "active", 300);
			advanceSessionActivity(db, "idle", 100);
			const provider = new PiRetrospectiveRawProvider({
				projectCwd: "/repo",
				contextDb: db,
				listSessions: () => [
					{
						id: "active",
						cwd: "/repo",
						path: "/sessions/a.jsonl",
						modified: 10,
					},
					{
						id: "idle",
						cwd: "/repo",
						path: "/sessions/i.jsonl",
						modified: 400,
					},
				],
			});
			expect(
				(await provider.listProjectSessions("project")).map(
					({ sessionId, updatedAt }) => ({ sessionId, updatedAt }),
				),
			).toEqual([
				{ sessionId: "idle", updatedAt: 100 },
				{ sessionId: "active", updatedAt: 300 },
			]);
		} finally {
			db.close();
		}
	});
	it("lists sessions for the resolved project cwd", async () => {
		const provider = new PiRetrospectiveRawProvider({
			projectCwd: "/repo/project",
			listSessions: () => [
				{
					id: "s1",
					cwd: "/repo/project",
					path: "/sessions/s1.jsonl",
					modified: 30,
				},
				{
					id: "s0",
					cwd: "/repo/project",
					path: "/sessions/s0.jsonl",
					modified: 20,
				},
				{
					id: "s2",
					cwd: "/repo/other",
					path: "/sessions/s2.jsonl",
					modified: 40,
				},
			],
			loadEntriesFromFile: () => [],
		});

		expect(await provider.listProjectSessions("identity")).toEqual([
			{ sessionId: "s0", path: "/sessions/s0.jsonl", updatedAt: 20 },
			{ sessionId: "s1", path: "/sessions/s1.jsonl", updatedAt: 30 },
		]);
	});

	it("reads only typed user messages newer than sinceMs", async () => {
		const provider = new PiRetrospectiveRawProvider({
			projectCwd: "/repo/project",
			listSessions: () => [
				{
					id: "s1",
					cwd: "/repo/project",
					path: "/sessions/s1.jsonl",
					modified: 30,
				},
			],
			loadEntriesFromFile: () => [
				{
					type: "message",
					message: { role: "user", timestamp: 100, content: "old" },
				},
				{
					type: "message",
					message: {
						role: "toolResult",
						timestamp: 200,
						content: "tool output",
					},
				},
				{
					type: "custom_message",
					message: { role: "user", timestamp: 250, content: "nudge" },
				},
				{
					type: "message",
					message: {
						role: "user",
						timestamp: 300,
						content: [
							{ type: "text", text: "new line" },
							{ type: "image", data: "ignored" },
							{ type: "text", text: "second line" },
						],
					},
				},
			],
		});

		await provider.listProjectSessions("identity");
		expect(await provider.readUserMessagesSince("s1", 150, 10)).toEqual({
			messages: [
				{
					sessionId: "s1",
					ordinal: 4,
					role: "user",
					text: "new line\nsecond line",
					ts: 300,
				},
			],
			truncated: false,
		});
	});

	it("inherits the shared clamp and oldest-first prompt budget for JSONL messages", async () => {
		const start = Date.now() - 1_000;
		const provider = new PiRetrospectiveRawProvider({
			projectCwd: "/repo/project",
			listSessions: () => [
				{
					id: "s1",
					cwd: "/repo/project",
					path: "/sessions/s1.jsonl",
					modified: start + 100,
				},
			],
			loadEntriesFromFile: () =>
				Array.from({ length: 6 }, (_, index) => ({
					type: "message",
					message: {
						role: "user",
						timestamp: start + index * 10,
						content: `pi-${index + 1} ${"oversized jsonl paste ".repeat(20_000)}`,
					},
				})),
		});

		const win = await readRetrospectiveScanWindow(provider, "identity", 0, 0, {
			usableInputTokens: 4_000,
		});

		expect(win.budgetTruncated).toBe(true);
		expect(win.messages.length).toBeGreaterThan(0);
		expect(win.messages.length).toBeLessThan(6);
		expect(win.messages[0]?.text).toStartWith("pi-1");
		expect(
			win.messages.every(
				(message) =>
					message.text.length <= RETROSPECTIVE_MAX_USER_MESSAGE_CHARS,
			),
		).toBe(true);
	});

	it("readUserMessagesBefore returns the newest N typed user lines at/before the cutoff", async () => {
		const provider = new PiRetrospectiveRawProvider({
			projectCwd: "/repo/project",
			listSessions: () => [
				{
					id: "s1",
					cwd: "/repo/project",
					path: "/sessions/s1.jsonl",
					modified: 30,
				},
			],
			loadEntriesFromFile: () => [
				{
					type: "message",
					message: { role: "user", timestamp: 100, content: "first" },
				},
				{
					type: "message",
					message: { role: "user", timestamp: 200, content: "second" },
				},
				{
					type: "message",
					message: { role: "user", timestamp: 300, content: "third" },
				},
				// after the cutoff — excluded
				{
					type: "message",
					message: { role: "user", timestamp: 400, content: "future" },
				},
			],
		});

		await provider.listProjectSessions("identity");
		// cutoff=300, count=2 → the 2 newest user lines AT/BEFORE 300, oldest→newest.
		const before = await provider.readUserMessagesBefore("s1", 300, 2);
		expect(before.map((m) => m.text)).toEqual(["second", "third"]);
		expect(before.every((m) => m.ts <= 300)).toBe(true);
	});
});
