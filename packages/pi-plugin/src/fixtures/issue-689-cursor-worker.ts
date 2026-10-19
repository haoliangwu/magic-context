import { initializeDatabase } from "@magic-context/core/features/magic-context/storage-db";
import { Database } from "@magic-context/core/shared/sqlite";
import {
	piUpperReclaimCursor,
	shouldReclaimPiUpperEstimate,
} from "../pi-fit-reclaim";

// The parent supplies an initialized temporary SQLite path and the preload's
// environment variables, keeping this child away from the operator's data.
const [path, sessionId] = process.argv.slice(2);
if (!path || !sessionId || !process.env.MAGIC_CONTEXT_TEST_DATA_DIR)
	throw new Error("isolated review database and session required");
const db = new Database(path);
initializeDatabase(db);
const cursor = piUpperReclaimCursor({
	sessionId,
	modelKey: "mock/mock",
	messageCount: 1,
	input: [{ role: "user", content: "unchanged", timestamp: 1 }],
});
try {
	console.log(`READY:${shouldReclaimPiUpperEstimate(db, cursor)}`);
	// Wait until the other process has durably claimed the same request.
	await new Promise<void>((resolve, reject) => {
		process.stdin.once("end", resolve);
		process.stdin.once("error", reject);
		process.stdin.resume();
	});
	console.log(`CLAIM:${shouldReclaimPiUpperEstimate(db, cursor)}`);
} finally {
	db.close();
}
