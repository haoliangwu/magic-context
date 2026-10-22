import { expect, spyOn, test } from "bun:test";
import * as embedding from "@magic-context/core/features/magic-context/memory/embedding";
import { runMigrations } from "@magic-context/core/features/magic-context/migrations";
import { initializeDatabase } from "@magic-context/core/features/magic-context/storage-db";
import * as workers from "@magic-context/core/hooks/magic-context/auto-search-worker-client";
import {
	_resetHarnessForTesting,
	setHarness,
} from "@magic-context/core/shared/harness";
import { Database } from "@magic-context/core/shared/sqlite";
import { autoSearchTestSnapshot } from "../../plugin/src/hooks/magic-context/auto-search-snapshot.fixture";
import { runAutoSearchHintForPi } from "./auto-search-pi";

test("Pi new hints pass archive cutoff and current entry exclusion", async () => {
	_resetHarnessForTesting();
	setHarness("pi");
	const db = new Database(":memory:");
	initializeDatabase(db);
	runMigrations(db);
	const search = spyOn(workers, "searchAutoHint").mockResolvedValue([]);
	const backfill = spyOn(
		workers,
		"queueAutoSearchBackfill",
	).mockResolvedValue();
	const snapshot = spyOn(
		embedding,
		"getProjectEmbeddingSnapshot",
	).mockReturnValue(autoSearchTestSnapshot("/synthetic"));
	const invoke = (id: string) =>
		runAutoSearchHintForPi({
			db,
			sessionId: "session",
			messages: [
				{ role: "user", content: "historian cache wiring", timestamp: 1 },
			],
			entryIds: [id],
			options: {
				enabled: true,
				projectPath: "/synthetic",
				minPromptChars: 10,
				scoreThreshold: 0.6,
			},
		});
	try {
		await invoke("first");
		expect(search.mock.calls[0][4].maxMessageOrdinal).toBe(0);
		expect(search.mock.calls[0][4].excludeMessageId).toBe("first");
		db.exec(`INSERT INTO compartments (session_id,sequence,start_message,end_message,start_message_id,end_message_id,title,content,p1,created_at,harness)
            VALUES ('session',0,1,2,'u1','a2','Archived history','stored','stored',1,'pi')`);
		await invoke("next");
		expect(search.mock.calls[1][4].maxMessageOrdinal).toBe(2);
		expect(search.mock.calls[1][4].excludeMessageId).toBe("next");
	} finally {
		search.mockRestore();
		backfill.mockRestore();
		snapshot.mockRestore();
		db.close();
		_resetHarnessForTesting();
	}
});
