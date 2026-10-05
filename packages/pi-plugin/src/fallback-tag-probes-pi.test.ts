import { expect, spyOn, test } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runMigrations } from "@magic-context/core/features/magic-context/migrations";
import { initializeDatabase } from "@magic-context/core/features/magic-context/storage-db";
import { Database } from "@magic-context/core/shared/sqlite";
import { createTestTempDirFromPath } from "../../plugin/src/shared/test-temp-dir";
import {
	hasPiFallbackMessageTags,
	hasPiFallbackToolOwnerTags,
} from "./fallback-tag-probes-pi";

test("Pi fallback probes cache metadata-only passes and see local, sibling and rollback tag changes", () => {
	const root = createTestTempDirFromPath(join(tmpdir(), "pi-fallback-probes-"));
	const db = new Database(join(root, "context.db"));
	initializeDatabase(db);
	runMigrations(db);
	const sibling = new Database(join(root, "context.db"));
	const insert = (
		connection: Database,
		id: string,
		number: number,
		type = "message",
	) =>
		connection
			.prepare(
				"INSERT INTO tags(session_id,message_id,tag_number,type,status,byte_size,tool_owner_message_id) VALUES('session',?,?,?,'active',0,?)",
			)
			.run(id, number, type, id);
	try {
		insert(db, "real-entry", 1);
		expect(hasPiFallbackMessageTags(db, "session")).toBe(false);
		expect(hasPiFallbackToolOwnerTags(db, "session")).toBe(false);
		const prepare = spyOn(db, "prepare");
		try {
			db.prepare("UPDATE session_meta SET last_context_percentage=1").run();
			expect(hasPiFallbackMessageTags(db, "session")).toBe(false);
			expect(hasPiFallbackToolOwnerTags(db, "session")).toBe(false);
			expect(
				prepare.mock.calls.filter(([sql]) => sql.includes("LIKE 'pi-msg-%'")),
			).toHaveLength(0);
		} finally {
			prepare.mockRestore();
		}
		insert(sibling, "PI-MSG-sibling", 2);
		expect(hasPiFallbackMessageTags(db, "session")).toBe(true);
		db.prepare("DELETE FROM tags WHERE tag_number=2").run();
		expect(hasPiFallbackMessageTags(db, "session")).toBe(false);
		db.exec("BEGIN");
		insert(db, "pi-msg-rollback", 3, "tool");
		expect(hasPiFallbackToolOwnerTags(db, "session")).toBe(true);
		db.exec("ROLLBACK");
		expect(hasPiFallbackToolOwnerTags(db, "session")).toBe(false);
		insert(db, "pi-msg-tool", 4, "tool");
		expect(hasPiFallbackToolOwnerTags(db, "session")).toBe(true);
	} finally {
		sibling.close();
		db.close();
		rmSync(root, { recursive: true, force: true });
	}
});
