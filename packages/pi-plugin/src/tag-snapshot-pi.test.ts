import { expect, it, spyOn } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runMigrations } from "@magic-context/core/features/magic-context/migrations";
import { initializeDatabase } from "@magic-context/core/features/magic-context/storage-db";
import { getTagsBySession } from "@magic-context/core/features/magic-context/storage-tags";
import { Database } from "@magic-context/core/shared/sqlite";
import { createTestTempDirFromPath } from "../../plugin/src/shared/test-temp-dir";
import { createPiTagSnapshotReader } from "./tag-snapshot-pi";

it("tag snapshots reuse unchanged rows and invalidate local, external and rollback changes", () => {
	const root = createTestTempDirFromPath(join(tmpdir(), "pi-tags-"));
	const db = new Database(join(root, "context.db"));
	initializeDatabase(db);
	runMigrations(db);
	const other = new Database(join(root, "context.db"));
	initializeDatabase(other);
	const insert = (connection: Database, id: string, number: number) =>
		connection
			.prepare(
				"INSERT INTO tags (message_id, type, status, session_id, tag_number, byte_size) VALUES (?, 'message', 'active', 'session', ?, 0)",
			)
			.run(id, number);
	try {
		insert(db, "one", 1);
		const read = createPiTagSnapshotReader(db);
		const first = read("session");
		const prepare = spyOn(db, "prepare");
		try {
			const firstTag = first[0];
			if (!firstTag) throw new Error("expected seeded tag");
			firstTag.status = "dropped";
			expect(read("session")[0]?.status).toBe("active");
			db.prepare("UPDATE session_meta SET last_context_percentage = 1").run();
			read("session");
			expect(
				prepare.mock.calls.filter(([sql]) =>
					sql.includes("FROM tags WHERE session_id"),
				),
			).toHaveLength(0);
		} finally {
			prepare.mockRestore();
		}
		db.prepare(
			"UPDATE tags SET status = 'dropped' WHERE message_id = 'one'",
		).run();
		expect(read("session")[0]?.status).toBe("dropped");
		insert(other, "two", 2);
		expect(read("session")).toHaveLength(2);
		db.exec("BEGIN");
		insert(db, "three", 3);
		expect(read("session")).toHaveLength(3);
		db.exec("ROLLBACK");
		expect(read("session")).toHaveLength(2);
		db.prepare("DELETE FROM tags WHERE message_id = 'two'").run();
		expect(read("session")).toHaveLength(1);
	} finally {
		other.close();
		db.close();
		rmSync(root, { recursive: true, force: true });
	}
});

it("tag snapshots refresh only changed numbers on append and preserve canonical bytes", () => {
	const db = new Database(":memory:");
	initializeDatabase(db);
	runMigrations(db);
	try {
		const insert = db.prepare(
			"INSERT INTO tags (message_id, type, status, session_id, tag_number, byte_size) VALUES (?, 'message', 'active', ?, ?, 0)",
		);
		db.transaction(() => {
			for (let i = 1; i <= 2000; i++) insert.run(`m-${i}`, "session", i);
		})();
		const read = createPiTagSnapshotReader(db);
		read("session");
		const prepare = spyOn(db, "prepare");
		try {
			insert.run("tail", "session", 2001);
			const appended = read("session");
			expect(
				prepare.mock.calls.filter(
					([sql]) =>
						sql.includes("FROM tags WHERE session_id") &&
						!sql.includes("tag_number IN"),
				),
			).toHaveLength(0);
			expect(JSON.stringify(appended)).toBe(
				JSON.stringify(getTagsBySession(db, "session")),
			);
		} finally {
			prepare.mockRestore();
		}
		// Renumbers, moves and deletes dirty both old and new keys.
		db.prepare(
			"UPDATE tags SET tag_number = 3000, status = 'dropped' WHERE message_id = 'm-2'",
		).run();
		db.prepare(
			"UPDATE tags SET session_id = 'other' WHERE message_id = 'm-3'",
		).run();
		db.prepare("DELETE FROM tags WHERE message_id = 'm-4'").run();
		expect(read("session")).toEqual(getTagsBySession(db, "session"));
		read("other");
		db.prepare(
			"UPDATE tags SET session_id = 'session' WHERE message_id = 'm-3'",
		).run();
		expect(read("session")).toEqual(getTagsBySession(db, "session"));
		expect(read("other")).toEqual(getTagsBySession(db, "other"));
		db.exec("BEGIN");
		insert.run("rolled-back", "session", 4000);
		expect(read("session")).toEqual(getTagsBySession(db, "session"));
		db.exec("ROLLBACK");
		insert.run("committed", "session", 4001);
		expect(read("session")).toEqual(getTagsBySession(db, "session"));
		db.prepare(
			"UPDATE tags SET byte_size = 42 WHERE session_id = 'session'",
		).run();
		expect(read("session")).toEqual(getTagsBySession(db, "session"));
	} finally {
		db.close();
	}
});

it("replaces legacy TEMP revision triggers before incremental reads", () => {
	const db = new Database(":memory:");
	initializeDatabase(db);
	runMigrations(db);
	try {
		db.exec(`CREATE TEMP TABLE pi_tag_revision (revision INTEGER NOT NULL);
            INSERT INTO pi_tag_revision VALUES (0);
            CREATE TEMP TRIGGER pi_tag_insert AFTER INSERT ON main.tags BEGIN
                UPDATE pi_tag_revision SET revision = revision + 1;
            END;`);
		const insert = db.prepare(
			"INSERT INTO tags (message_id, type, status, session_id, tag_number, byte_size) VALUES (?, 'message', 'active', 'session', ?, 0)",
		);
		insert.run("first", 1);
		const read = createPiTagSnapshotReader(db);
		expect(read("session")).toHaveLength(1);
		insert.run("second", 2);
		expect(read("session")).toEqual(getTagsBySession(db, "session"));
		// Outer conflict policies must not turn a repeated journal key into a
		// constraint error inside the trigger.
		insert.run("third", 3);
		db.prepare(
			"UPDATE OR ABORT tags SET byte_size = 1 WHERE message_id = 'third'",
		).run();
		db.prepare(
			"UPDATE OR ABORT tags SET byte_size = 2 WHERE message_id = 'third'",
		).run();
		expect(read("session")).toEqual(getTagsBySession(db, "session"));
	} finally {
		db.close();
	}
});

it("100k-tag snapshots ignore foreign metadata and other sessions, but reload foreign same-session edits and reopened connections", () => {
	const root = createTestTempDirFromPath(join(tmpdir(), "pi-tags-foreign-"));
	const path = join(root, "context.db");
	const db = new Database(path);
	initializeDatabase(db);
	runMigrations(db);
	const other = new Database(path);
	initializeDatabase(other);
	const insert = db.prepare(
		"INSERT INTO tags (message_id,type,status,session_id,tag_number,byte_size) VALUES (?,'message','active',?, ?,0)",
	);
	try {
		db.transaction(() => {
			for (let i = 1; i <= 100_000; i++) insert.run(`m-${i}`, "session", i);
		})();
		const read = createPiTagSnapshotReader(db);
		read("session");
		const prepare = spyOn(db, "prepare");
		try {
			other
				.prepare(
					"INSERT OR REPLACE INTO schema_migrations_meta VALUES ('foreign-metadata', '1')",
				)
				.run();
			other
				.prepare(
					"INSERT INTO tags (message_id,type,status,session_id,tag_number,byte_size) VALUES ('foreign','message','active','other',1,0)",
				)
				.run();
			read("session");
			insert.run("appended", "session", 100_001);
			expect(read("session").at(-1)?.messageId).toBe("appended");
			expect(
				prepare.mock.calls.filter(
					([sql]) =>
						sql.includes("FROM tags WHERE session_id") &&
						!sql.includes("tag_number IN"),
				),
			).toHaveLength(0);
		} finally {
			prepare.mockRestore();
		}
		other
			.prepare(
				"UPDATE tags SET status='dropped', byte_size=42 WHERE message_id='m-1'",
			)
			.run();
		expect(read("session")).toEqual(getTagsBySession(db, "session"));
		other.exec("BEGIN");
		other
			.prepare(
				"UPDATE tags SET tag_number=200000, message_id='renamed' WHERE message_id='m-2'",
			)
			.run();
		other.exec("ROLLBACK");
		expect(read("session")[1]?.messageId).toBe("m-2");
		other
			.prepare(
				"UPDATE tags SET session_id='other', tag_number=2 WHERE message_id='m-2'",
			)
			.run();
		other.prepare("DELETE FROM tags WHERE message_id='m-3'").run();
		insert.run("local-with-foreign", "session", 100_002);
		expect(read("session")).toEqual(getTagsBySession(db, "session"));
		const reopened = new Database(path);
		initializeDatabase(reopened);
		try {
			const spy = spyOn(reopened, "prepare");
			try {
				expect(createPiTagSnapshotReader(reopened)("session")).toEqual(
					getTagsBySession(db, "session"),
				);
				expect(
					spy.mock.calls.some(
						([sql]) =>
							sql.includes("FROM tags WHERE session_id") &&
							!sql.includes("tag_number IN"),
					),
				).toBe(true);
			} finally {
				spy.mockRestore();
			}
		} finally {
			reopened.close();
		}
	} finally {
		other.close();
		db.close();
		rmSync(root, { recursive: true, force: true });
	}
}, 60_000);
