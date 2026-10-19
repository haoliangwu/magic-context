import { expect, it } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runMigrations } from "@magic-context/core/features/magic-context/migrations";
import { initializeDatabase } from "@magic-context/core/features/magic-context/storage-db";
import {
	getTagsBySession,
	hasPiFallbackMessageTags as tableHasFallbackMessageTags,
	hasPiFallbackToolOwnerTags as tableHasFallbackToolOwnerTags,
} from "@magic-context/core/features/magic-context/storage-tags";
import { Database } from "@magic-context/core/shared/sqlite";
import { createTestTempDirFromPath } from "../../plugin/src/shared/test-temp-dir";
import {
	hasPiFallbackMessageTags,
	hasPiFallbackToolOwnerTags,
} from "./fallback-tag-probes-pi";
import {
	getPiActiveTagSnapshotView,
	getPiTagSnapshotView,
	readPiFallbackTagRows,
} from "./tag-snapshot-pi";

/** Small deterministic PRNG so a failure names a reproducible operation sequence. */
function prng(seed: number) {
	let state = seed >>> 0;
	return (limit: number) => {
		state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
		return state % limit;
	};
}

const MESSAGE_IDS = [
	"entry-a:p0",
	"entry-b:p0",
	"pi-msg-1-user:p0",
	"PI-MSG-2-assistant:p0",
	"Pi-Msg-3-user:p1",
	"pi_msg-not-fallback:p0",
];
const OWNERS = [null, "entry-a", "pi-msg-4-assistant", "PI-MSG-5-assistant"];

function openPair() {
	const root = createTestTempDirFromPath(join(tmpdir(), "pi-tag-projections-"));
	const path = join(root, "context.db");
	const db = new Database(path);
	initializeDatabase(db);
	runMigrations(db);
	// Another process sharing context.db, initialized as Magic Context writers are.
	const foreign = new Database(path);
	initializeDatabase(foreign);
	return {
		db,
		foreign,
		close() {
			foreign.close();
			db.close();
			rmSync(root, { recursive: true, force: true });
		},
	};
}

/**
 * Apply one random tag write: insert, status/type/id/owner/fingerprint update,
 * renumber, cross-session move, REPLACE or delete, from either connection,
 * sometimes inside a rolled-back transaction.
 */
function randomWrite(
	pick: (limit: number) => number,
	db: Database,
	foreign: Database,
	nextNumber: () => number,
) {
	const connection = pick(3) === 0 ? foreign : db;
	const number = 1 + pick(40);
	const statements: [string, unknown[]][] = [
		[
			"INSERT OR IGNORE INTO tags (session_id, message_id, type, status, tag_number, byte_size, tool_owner_message_id, entry_fingerprint) VALUES ('s', ?, ?, ?, ?, 0, ?, ?)",
			[
				MESSAGE_IDS[pick(MESSAGE_IDS.length)],
				pick(3) === 0 ? "tool" : "message",
				["active", "dropped", "compacted"][pick(3)],
				nextNumber(),
				OWNERS[pick(OWNERS.length)],
				pick(2) ? `fp-${pick(4)}` : null,
			],
		],
		[
			"UPDATE tags SET status = ? WHERE session_id = 's' AND tag_number = ?",
			[["active", "dropped", "compacted"][pick(3)], number],
		],
		[
			"UPDATE tags SET message_id = ?, type = ? WHERE session_id = 's' AND tag_number = ?",
			[
				MESSAGE_IDS[pick(MESSAGE_IDS.length)],
				pick(2) ? "tool" : "message",
				number,
			],
		],
		[
			"UPDATE tags SET tool_owner_message_id = ?, entry_fingerprint = ? WHERE session_id = 's' AND tag_number = ?",
			[OWNERS[pick(OWNERS.length)], pick(2) ? `fp-${pick(4)}` : null, number],
		],
		[
			"UPDATE OR IGNORE tags SET tag_number = ? WHERE session_id = 's' AND tag_number = ?",
			[nextNumber(), number],
		],
		[
			"UPDATE OR IGNORE tags SET session_id = ? WHERE session_id = ? AND tag_number = ?",
			pick(2) ? ["other", "s", number] : ["s", "other", number],
		],
		[
			"INSERT OR REPLACE INTO tags (session_id, message_id, type, status, tag_number, byte_size, tool_owner_message_id) VALUES ('s', ?, 'tool', 'active', ?, 0, ?)",
			[
				MESSAGE_IDS[pick(MESSAGE_IDS.length)],
				number,
				OWNERS[pick(OWNERS.length)],
			],
		],
		["DELETE FROM tags WHERE session_id = 's' AND tag_number = ?", [number]],
	];
	const [sql, args] = statements[pick(statements.length)] as [
		string,
		unknown[],
	];
	const rollback = pick(8) === 0;
	if (rollback) connection.exec("BEGIN");
	connection.prepare(sql).run(...(args as never[]));
	if (rollback) connection.exec("ROLLBACK");
}

function tableFallbackRows(db: Database) {
	return db
		.prepare(
			`SELECT id, tag_number, type, message_id, tool_owner_message_id, entry_fingerprint FROM tags
			 WHERE session_id = 's' AND ((type = 'message' AND message_id LIKE 'pi-msg-%')
			 OR (type = 'tool' AND tool_owner_message_id LIKE 'pi-msg-%')) ORDER BY id`,
		)
		.all();
}

it("the active tag projection equals a fresh status filter after local, foreign, rollback, renumber and move writes", () => {
	const { db, foreign, close } = openPair();
	try {
		let counter = 100;
		const nextNumber = () => counter++;
		const pick = prng(650);
		for (let step = 0; step < 1_500; step += 1) {
			randomWrite(pick, db, foreign, nextNumber);
			// Read the full snapshot on some steps only, so the projection also has
			// to absorb several journaled changes at once.
			if (pick(3) === 0) getPiTagSnapshotView(db, "s");
			const expected = getTagsBySession(db, "s").filter(
				(tag) => tag.status === "active",
			);
			const actual = getPiActiveTagSnapshotView(db, "s");
			expect({ step, rows: actual }).toEqual({ step, rows: expected });
		}
	} finally {
		close();
	}
});

it("cached fallback rows answer every pi-msg probe exactly like the table after mixed writes", () => {
	const { db, foreign, close } = openPair();
	try {
		let counter = 100;
		const nextNumber = () => counter++;
		const pick = prng(651);
		for (let step = 0; step < 1_500; step += 1) {
			randomWrite(pick, db, foreign, nextNumber);
			if (pick(4) === 0) getPiTagSnapshotView(db, "s");
			const rows = [...(readPiFallbackTagRows(db, "s") ?? [])].sort(
				(left, right) => left.id - right.id,
			);
			expect({ step, rows }).toEqual({ step, rows: tableFallbackRows(db) });
			expect({ step, message: hasPiFallbackMessageTags(db, "s") }).toEqual({
				step,
				message: tableHasFallbackMessageTags(db, "s"),
			});
			expect({ step, tool: hasPiFallbackToolOwnerTags(db, "s") }).toEqual({
				step,
				tool: tableHasFallbackToolOwnerTags(db, "s"),
			});
		}
		// Inside a transaction the probes read the table, including uncommitted rows.
		db.exec("BEGIN");
		db.prepare(
			"INSERT INTO tags (session_id, message_id, type, status, tag_number, byte_size, tool_owner_message_id) VALUES ('s', 'call', 'tool', 'active', ?, 0, 'pi-msg-9-assistant')",
		).run(nextNumber());
		expect(readPiFallbackTagRows(db, "s")).toBeNull();
		expect(hasPiFallbackToolOwnerTags(db, "s")).toBe(true);
		db.exec("ROLLBACK");
		expect(hasPiFallbackToolOwnerTags(db, "s")).toBe(
			tableHasFallbackToolOwnerTags(db, "s"),
		);
	} finally {
		close();
	}
});

it("a foreign write rereads the session but keeps every unchanged row object", () => {
	const { db, foreign, close } = openPair();
	try {
		const insert = db.prepare(
			"INSERT INTO tags (session_id, message_id, type, status, tag_number, byte_size) VALUES ('s', ?, 'message', 'active', ?, 0)",
		);
		db.transaction(() => {
			for (let number = 1; number <= 500; number += 1)
				insert.run(`entry-${number}:p0`, number);
		})();
		const before = getPiTagSnapshotView(db, "s");
		foreign
			.prepare(
				"UPDATE tags SET status = 'dropped' WHERE session_id = 's' AND tag_number = 250",
			)
			.run();
		const after = getPiTagSnapshotView(db, "s");
		expect(after).not.toBe(before);
		expect(after).toEqual(getTagsBySession(db, "s"));
		const changed = after.filter((row, index) => row !== before[index]);
		expect(changed.map((row) => [row.tagNumber, row.status])).toEqual([
			[250, "dropped"],
		]);
		expect(getPiActiveTagSnapshotView(db, "s")).toHaveLength(499);
	} finally {
		close();
	}
});
