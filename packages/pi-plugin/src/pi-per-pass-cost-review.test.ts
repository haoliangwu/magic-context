/**
 * Review witnesses for the Pi per-pass cost change (incremental active-tag
 * projection, cached fallback rows, target-only served-number lookup and the
 * writer-admission reuse of fallback existence probes).
 *
 * The two "witness" tests run by default: their findings are fixed (the
 * durable tags_version detector in tag-snapshot-pi.ts, and the shared tag state
 * of getPiActiveTagSnapshotView). Their names describe b960feedfb. The other
 * tests are skipped by default. Run one by name:
 *   PI_PER_PASS_COST_REVIEW=1 bun test src/pi-per-pass-cost-review.test.ts -t "<name>"
 *
 * "Master" means master at 43ddbe1bec, before the change; "the branch" means
 * the change at b960feedfb. Tests named "witness (red on the branch, green on
 * master)" assert the behaviour master had and the change lost. The test named
 * "known gap (red on master and on the branch)" asserts what
 * issue-640-review.test.ts expects for a sibling's dropped fallback row, in an
 * interleaving neither tree handles. The other tests pass on both trees.
 */
import { expect, spyOn, test } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initializeDatabase } from "@magic-context/core/features/magic-context/storage-db";
import { getPendingOps } from "@magic-context/core/features/magic-context/storage-ops";
import {
	getTagsBySession,
	hasPiFallbackMessageTags as tableHasFallbackMessageTags,
	hasPiFallbackToolOwnerTags as tableHasFallbackToolOwnerTags,
} from "@magic-context/core/features/magic-context/storage-tags";
import { createTagger } from "@magic-context/core/features/magic-context/tagger";
import { resetLkgSlotsForTest } from "@magic-context/core/hooks/magic-context/lkg-slot";
import { Database } from "@magic-context/core/shared/sqlite";
import { createTestTempDirFromPath } from "../../plugin/src/shared/test-temp-dir";
import {
	__test,
	clearContextHandlerSession,
	registerPiContextHandler,
} from "./context-handler";
import {
	hasPiFallbackMessageTags,
	hasPiFallbackToolOwnerTags,
} from "./fallback-tag-probes-pi";
import * as snapshotModule from "./tag-snapshot-pi";
import { getPiTagSnapshotView } from "./tag-snapshot-pi";
import {
	createFakePi,
	createTestDb,
	fakeContext,
	type PiMessage,
	textOf,
	userMessage,
} from "./test-utils.test";

type Tags = ReturnType<typeof getTagsBySession>;

/**
 * A context pass's active tags, derived the way runPipeline derives them from
 * the full tag list it read (allTagsForPass). With the change this is
 * getPiActiveTagSnapshotView(db, sessionId, allTagsForPass); before it (where
 * that export does not exist) it is a status filter of allTagsForPass. This
 * keeps the file loadable on both versions.
 */
const activeView = (db: Database, sessionId: string, allTags?: Tags) => {
	const branch = (
		snapshotModule as {
			getPiActiveTagSnapshotView?: (
				db: Database,
				sessionId: string,
				uncachedTags?: Tags,
			) => Tags;
		}
	).getPiActiveTagSnapshotView;
	return branch
		? branch(db, sessionId, allTags)
		: (allTags ?? getPiTagSnapshotView(db, sessionId)).filter(
				(tag) => tag.status === "active",
			);
};

const review = process.env.PI_PER_PASS_COST_REVIEW === "1" ? test : test.skip;

type Handler = (
	event: { messages: PiMessage[] },
	ctx: ReturnType<typeof fakeContext>,
) => Promise<{ messages: PiMessage[] }>;

function install(db: ReturnType<typeof createTestDb>): Handler {
	const fake = createFakePi();
	registerPiContextHandler(fake.pi as never, { db });
	return fake.handlers.get("context") as unknown as Handler;
}

/**
 * One store file with this process's initialized connection and a second
 * connection. initializeDatabase installs the connection-local TEMP triggers
 * that advance `tag_revision:<session>` on every tag write. With
 * `initialized: false` the second connection never runs it, so its tag writes
 * leave that counter alone. Released v0.47.x and v0.48.x builds write the
 * store the same way: they open the same schema version (95) but predate those
 * triggers.
 */
function openStore(initialized: boolean) {
	const dir = createTestTempDirFromPath(join(tmpdir(), "pi-cost-review-"));
	const path = join(dir, "context.db");
	const db = createTestDb(path);
	const sibling = new Database(path);
	if (initialized) initializeDatabase(sibling);
	// Open the sibling's view of the WAL now, so its first write inside a test
	// hook does not also pay for that.
	sibling.prepare("SELECT COUNT(*) FROM tags").get();
	return {
		db,
		sibling,
		close() {
			sibling.close();
			db.close();
			rmSync(dir, { recursive: true, force: true });
		},
	};
}

const insertTag = (
	db: Database,
	sessionId: string,
	number: number,
	messageId: string,
	extra: { type?: string; status?: string; owner?: string | null } = {},
) =>
	db
		.prepare(
			"INSERT INTO tags (session_id, message_id, type, status, tag_number, byte_size, tool_owner_message_id) VALUES (?, ?, ?, ?, ?, 0, ?)",
		)
		.run(
			sessionId,
			messageId,
			extra.type ?? "message",
			extra.status ?? "active",
			number,
			extra.owner ?? null,
		);

test("witness (red on the branch, green on master): an old-build sibling's fallback row is visible to the cached probes after a local tag write", () => {
	const { db, sibling, close } = openStore(false);
	try {
		insertTag(db, "s", 1, "entry-a:p0");
		// Inserting tag 1 created the session's `tag_revision:` row. A newly
		// created row gets a new serial, and a changed serial makes the next
		// snapshot read reload every row, which would hide the defect. So prime
		// both cached probes only after that row exists.
		expect(hasPiFallbackMessageTags(db, "s")).toBe(false);
		expect(hasPiFallbackToolOwnerTags(db, "s")).toBe(false);
		// The old-build process tags its in-flight message and tool call.
		insertTag(sibling, "s", 2, "pi-msg-0-1-user:p0");
		insertTag(sibling, "s", 3, "call-1", {
			type: "tool",
			owner: "pi-msg-0-2-assistant",
		});
		// This process then tags a new message of the same session. On master the
		// probe cache was keyed by this connection's own revision too, so this
		// write made the next probe query the table again.
		insertTag(db, "s", 4, "entry-b:p0");
		expect({
			message: hasPiFallbackMessageTags(db, "s"),
			tool: hasPiFallbackToolOwnerTags(db, "s"),
		}).toEqual({
			message: tableHasFallbackMessageTags(db, "s"),
			tool: tableHasFallbackToolOwnerTags(db, "s"),
		});
	} finally {
		close();
	}
});

review(
	"known gap (red on master and on the branch): an old-build sibling's drop for an already-served historical message is adopted on the next pass",
	async () => {
		const { db, sibling, close } = openStore(false);
		const sessionId = "review-cost-historical-adoption";
		try {
			const handler = install(db);
			const historical = userMessage("historical text", 1);
			const first = await handler(
				{ messages: [structuredClone(historical)] },
				fakeContext(sessionId, process.cwd(), ["historical"], [historical]),
			);
			expect(textOf(first.messages[0])).toContain("§1§ historical text");
			// A second ordinary pass. The first pass's tag created this session's
			// `tag_revision:` row; a new row is a new incarnation, which makes this
			// pass reload the snapshot in full. After this pass the cached fallback
			// rows are current and only change through this connection's journal.
			const second = [structuredClone(historical), userMessage("middle", 2)];
			await handler(
				{ messages: second },
				fakeContext(sessionId, process.cwd(), ["historical", "middle"], second),
			);
			const fingerprint = __test
				.buildEntryFingerprintMap([historical], () => "historical")
				.get("historical");
			// The same dropped fallback row that issue-640-review.test.ts inserts in
			// "adoption discovers a racing drop for an already-served historical
			// message", but committed between two passes instead of during a pass's
			// preflight.
			sibling
				.prepare(
					"INSERT INTO tags(message_id,type,status,session_id,tag_number,byte_size,entry_fingerprint) VALUES ('pi-msg-racing:p0','message','dropped',?,9,0,?)",
				)
				.run(sessionId, fingerprint);
			const raw = [
				...second.map((m) => structuredClone(m)),
				userMessage("new tail", 3),
			];
			const result = await handler(
				{ messages: raw },
				fakeContext(
					sessionId,
					process.cwd(),
					["historical", "middle", "tail"],
					raw,
				),
			);
			expect(textOf(result.messages[0])).toBe("§1§ historical text");
			expect({
				pending: getPendingOps(db, sessionId).map((op) => op.tagId),
				rows: db
					.prepare(
						"SELECT tag_number,status FROM tags WHERE session_id=? AND tag_number IN (1,9) ORDER BY tag_number",
					)
					.all(sessionId),
			}).toEqual({ pending: [1], rows: [{ tag_number: 1, status: "active" }] });
		} finally {
			clearContextHandlerSession(sessionId);
			resetLkgSlotsForTest();
			close();
		}
	},
);

review(
	"an initialized sibling's writes reach every cached projection after a local write",
	() => {
		const { db, sibling, close } = openStore(true);
		try {
			for (let number = 1; number <= 5; number += 1)
				insertTag(db, "s", number, `entry-${number}:p0`);
			// Prime the snapshot, the active projection and both fallback probes.
			getPiTagSnapshotView(db, "s");
			expect(activeView(db, "s")).toHaveLength(5);
			expect(hasPiFallbackMessageTags(db, "s")).toBe(false);
			expect(hasPiFallbackToolOwnerTags(db, "s")).toBe(false);
			// Another current-build process drops a tag and tags a fallback message
			// and tool call; then this process appends.
			sibling
				.prepare(
					"UPDATE tags SET status = 'dropped' WHERE session_id = 's' AND tag_number = 2",
				)
				.run();
			insertTag(sibling, "s", 6, "pi-msg-0-1-user:p0");
			insertTag(sibling, "s", 7, "call-1", {
				type: "tool",
				owner: "pi-msg-0-2-assistant",
			});
			insertTag(db, "s", 8, "entry-8:p0");
			const table = getTagsBySession(db, "s");
			expect({
				snapshot: getPiTagSnapshotView(db, "s"),
				active: activeView(db, "s"),
				message: hasPiFallbackMessageTags(db, "s"),
				tool: hasPiFallbackToolOwnerTags(db, "s"),
			}).toEqual({
				snapshot: table,
				active: table.filter((tag) => tag.status === "active"),
				message: true,
				tool: true,
			});
		} finally {
			close();
		}
	},
);

for (const initialized of [false, true]) {
	review(
		`a tool-owner fallback row a${initialized ? "n initialized" : "n old-build"} sibling commits just before writer admission is still re-keyed`,
		() => {
			const { db, sibling, close } = openStore(initialized);
			const exec = db.exec.bind(db);
			// The existence probe has already answered "none" when this runs: the
			// commit lands between discovery and BEGIN IMMEDIATE.
			const spy = spyOn(db, "exec").mockImplementation((sql) => {
				if (sql === "BEGIN IMMEDIATE")
					insertTag(sibling, "session", 4, "call-1", {
						type: "tool",
						owner: "pi-msg-0-1-assistant",
					});
				return exec(sql);
			});
			try {
				__test.adoptPiFallbackTags(db, "session", createTagger(), new Map(), {
					messages: [
						{
							role: "assistant",
							timestamp: 1,
							content: [
								{ type: "toolCall", id: "call-1", name: "read", arguments: {} },
							],
						} as never,
					],
					resolveStableId: () => "real-owner",
				});
				expect(
					db
						.prepare(
							"SELECT tag_number, message_id, tool_owner_message_id FROM tags WHERE session_id = 'session'",
						)
						.all(),
				).toEqual([
					{
						tag_number: 4,
						message_id: "call-1",
						tool_owner_message_id: "real-owner",
					},
				]);
			} finally {
				spy.mockRestore();
				close();
			}
		},
	);
}

test("witness (red on the branch, green on master): a foreign commit between the two snapshot reads of a pass cannot split its active tags from its full tags", () => {
	const { db, sibling, close } = openStore(true);
	try {
		for (let number = 1; number <= 5; number += 1)
			insertTag(db, "s", number, `entry-${number}:p0`);
		getPiTagSnapshotView(db, "s");
		// runPipeline reads allTagsForPass, then its active tags, as two calls.
		const allTagsForPass = getPiTagSnapshotView(db, "s");
		// Another process commits in between: it drops tag 3 and tags a new
		// message.
		sibling
			.prepare(
				"UPDATE tags SET status = 'dropped' WHERE session_id = 's' AND tag_number = 3",
			)
			.run();
		insertTag(sibling, "s", 6, "entry-6:p0");
		const activeTags = activeView(db, "s", allTagsForPass);
		// The pass uses both lists (computeProtectionWindow, servedTagNumbers and
		// the channel baseline read allTagsForPass; heuristics, the count-based
		// protection window and protected tool tags read activeTags). On master
		// the second is always a filter of the first.
		expect(activeTags.map((tag) => tag.tagNumber)).toEqual(
			allTagsForPass
				.filter((tag) => tag.status === "active")
				.map((tag) => tag.tagNumber),
		);
	} finally {
		close();
	}
});
