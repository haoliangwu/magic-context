import { afterEach, describe, expect, it } from "bun:test";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestTempDirFromPath } from "../../../plugin/src/shared/test-temp-dir";
import { convertEntriesToRawMessages } from "../read-session-pi";
import { sessionEntries } from "./bounded-session-reader";
import { createPiPrimerRawProviderFactory } from "./primer-raw-provider-pi";
import { PiRetrospectiveRawProvider } from "./retrospective-raw-provider-pi";
import { latestPiMessageTime } from "./session-activity-pi";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0))
		rmSync(dir, { recursive: true, force: true });
});

// Pi stores pasted images inline as base64, so one session line can run to
// megabytes. 2 MB is well over the reader's 1 MB per-entry bound.
const IMAGE_DATA = "A".repeat(2 * 1024 * 1024);

function writeSession(entries: unknown[]): { dir: string; path: string } {
	const dir = createTestTempDirFromPath(join(tmpdir(), "mc-pi-bounded-"));
	dirs.push(dir);
	const path = join(dir, "session.jsonl");
	writeFileSync(
		path,
		[
			{ type: "session", version: 3, id: "origin", cwd: "/repo/project" },
			...entries,
		]
			.map((entry) => JSON.stringify(entry))
			.join("\n"),
	);
	return { dir, path };
}

/** What Pi's own loader sees: every line parsed, malformed lines skipped. */
function fullEntries(path: string): unknown[] {
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

const message = (id: string, parentId: string | null, body: unknown) => ({
	type: "message",
	id,
	parentId,
	timestamp: "2026-01-01T00:00:00.000Z",
	message: body,
});

const SESSION = [
	message("u1", null, { role: "user", content: "first", timestamp: 100 }),
	message("u2", "u1", {
		role: "user",
		content: [
			{ type: "text", text: "what is in this screenshot?" },
			{ type: "image", data: IMAGE_DATA, mimeType: "image/png" },
		],
		timestamp: 200,
	}),
	message("a1", "u2", {
		role: "assistant",
		content: [{ type: "toolCall", id: "call-1", name: "read", arguments: {} }],
		stopReason: "toolUse",
		timestamp: 300,
	}),
	message("r1", "a1", {
		role: "toolResult",
		toolCallId: "call-1",
		toolName: "read",
		content: [{ type: "image", data: IMAGE_DATA, mimeType: "image/png" }],
		isError: false,
		timestamp: 400,
	}),
	message("u3", "r1", { role: "user", content: "third", timestamp: 500 }),
];

describe("bounded Pi session reader with an oversized entry", () => {
	it("keeps the oversized entry's place, identity and role", () => {
		const { path } = writeSession(SESSION);

		const bounded = [...sessionEntries(path)] as Array<{
			type?: string;
			id?: string;
			message?: { role?: string; content?: unknown };
		}>;
		const full = fullEntries(path) as typeof bounded;

		expect(
			bounded.map((entry) => [entry.type, entry.id, entry.message?.role]),
		).toEqual(full.map((entry) => [entry.type, entry.id, entry.message?.role]));
		expect(bounded[2]?.message?.content).toEqual([]);
	});

	it("lets the dreamer read the rest of the session at the same ordinals", async () => {
		const { dir, path } = writeSession(SESSION);
		const bounded = new PiRetrospectiveRawProvider({
			projectCwd: "/repo/project",
			sessionDir: dir,
		});
		const reference = new PiRetrospectiveRawProvider({
			projectCwd: "/repo/project",
			sessionDir: dir,
			loadEntriesFromFile: () => fullEntries(path),
		});
		await bounded.listProjectSessions("identity");
		await reference.listProjectSessions("identity");

		const read = await bounded.readUserMessagesSince("origin", 0, 10);
		const expected = await reference.readUserMessagesSince("origin", 0, 10);

		expect(read.messages.map((m) => [m.ordinal, m.text])).toEqual([
			[2, "first"],
			[6, "third"],
		]);
		expect(read.messages.map((m) => [m.ordinal, m.text])).toEqual(
			expected.messages
				.filter((m) => m.text === "first" || m.text === "third")
				.map((m) => [m.ordinal, m.text]),
		);
	});

	it("still finds the session's latest message time", () => {
		const { path } = writeSession([
			...SESSION.slice(0, 1),
			message("u9", "u1", {
				role: "user",
				content: [{ type: "image", data: IMAGE_DATA }],
				timestamp: 900,
			}),
		]);

		expect(latestPiMessageTime(path)).toBe(900);
	});

	it("pages primer history at the ordinals the full conversion assigns", async () => {
		const { dir, path } = writeSession(SESSION);
		const provider = await createPiPrimerRawProviderFactory({
			sessionDir: dir,
		})("origin");
		if (!provider?.readMessagePage) throw new Error("Missing bounded provider");
		const full = convertEntriesToRawMessages(fullEntries(path));

		const paged = provider.readMessagePage(0, 100, full.length);

		expect(paged.map((m) => [m.ordinal, m.id, m.role])).toEqual(
			full.map((m) => [m.ordinal, m.id, m.role]),
		);
		expect(paged.at(-1)?.parts).toContainEqual(
			expect.objectContaining({ callID: "call-1" }),
		);
	});
});
