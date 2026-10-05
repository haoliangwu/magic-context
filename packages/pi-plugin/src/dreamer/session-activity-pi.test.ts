import { expect, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readSessionActivity } from "@magic-context/core/features/magic-context/session-activity";
import { Database } from "@magic-context/core/shared/sqlite";
import { createTestTempDirFromPath } from "../../../plugin/src/shared/test-temp-dir";
import {
	backfillPiSessionActivity,
	latestPiMessageTime,
	observePiMessageActivity,
} from "./session-activity-pi";

const dir = createTestTempDirFromPath(join(tmpdir(), "pi-activity-"));
test("Pi/OMP message feed and JSONL entry backfill use message timestamps", async () => {
	const db = new Database(":memory:");
	try {
		db.exec(`CREATE TABLE schema_migrations_meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
			CREATE TABLE session_projects(session_id TEXT, harness TEXT, project_path TEXT, updated_at INTEGER);`);
		const path = join(dir, "session.jsonl");
		writeFileSync(
			path,
			[
				JSON.stringify({ type: "session", timestamp: "2020-01-01T00:00:00Z" }),
				JSON.stringify({
					type: "message",
					message: { timestamp: 100, role: "user" },
				}),
				JSON.stringify({
					type: "message",
					message: { timestamp: 200, role: "assistant" },
				}),
			].join("\n"),
		);
		expect(latestPiMessageTime(path)).toBe(200);
		for (const harness of ["pi", "omp"]) {
			db.prepare(
				"INSERT INTO session_projects VALUES (?, ?, '/repo', 900)",
			).run(`${harness}-session`, harness);
			await backfillPiSessionActivity(
				db,
				harness,
				new Map([[`${harness}-session`, path]]),
			);
			expect(readSessionActivity(db, `${harness}-session`)).toBe(200);
		}
		observePiMessageActivity(db, "live");
		expect(readSessionActivity(db, "live")).toBeGreaterThan(200);
	} finally {
		db.close();
		rmSync(dir, { recursive: true, force: true });
	}
});
