import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";
import { openDatabase } from "@magic-context/core/features/magic-context/storage-db";
import {
	__test as decisions,
	recordPendingPiTransformDecision,
	schedulePiTransformDecisionResolve,
} from "@magic-context/core/features/magic-context/transform-decision-log";
import { createTestTempDir } from "../../plugin/src/shared/test-temp-dir";
import { PiContextBudget } from "./pi-context-budget";

// Pi writes a busting pass's transform_decisions row late: the pass does not
// know the id of the assistant that will answer its request, so the next
// context pass resolves it and queues the write. The cache-bust analyzer and
// sentinel join a reclaim to its pass through that row; without it, a reclaim
// reads as an unaccounted bust with no Magic Context pass (no_mc_pass_row).

const reclaimDecision = {
	tsMs: 1,
	decision: "execute" as const,
	materialized: false,
	materializeReason: null,
	systemHashPrev: null,
	systemHashNew: null,
	m0ModelKeyPrev: null,
	m0ModelKeyNew: null,
	emergency: false,
	droppedTokens: 1_000,
	droppedCount: 3,
	inputTokens: 280_000,
	bustedThisPass: true,
};

afterEach(() => decisions.reset());

/** The queued write needs a file-backed database; it only reads its path. */
function withThrowawayDb<T>(
	label: string,
	run: (db: NonNullable<ReturnType<typeof openDatabase>>) => Promise<T>,
): Promise<T> {
	const { dir, cleanup } = createTestTempDir(label);
	const db = openDatabase(join(dir, "context.db"));
	if (!db) throw new Error("throwaway database unavailable");
	return run(db).finally(() => {
		db.close();
		cleanup();
	});
}

async function resolveOnNextPass(
	db: NonNullable<ReturnType<typeof openDatabase>>,
	sessionId: string,
): Promise<string[]> {
	const written: string[] = [];
	decisions.setWriterForTests((_path, row) => {
		written.push(`${row.harness}:${row.messageId}:${row.decision}`);
	});
	// The resolving pass is a fresh pass well inside its own deadline, so whether
	// the row is written depends only on the reclaim pass's publication guard.
	const nextPass = new PiContextBudget();
	schedulePiTransformDecisionResolve({
		db,
		sessionId,
		branchEntries: [
			{ type: "message", id: "a-before", message: { role: "assistant" } },
			{ type: "message", id: "a-reclaim", message: { role: "assistant" } },
		],
		assertCurrentPass: nextPass.assert,
	});
	await new Promise((resolve) => setTimeout(resolve, 10));
	return written;
}

test("a completed reclaim records its decision row when the next pass starts 30 s later", async () => {
	const sessionId = "ses-pi-reclaim-decision-30s";
	await withThrowawayDb("mc-pi-decision-30s-", async (db) => {
		let now = 0;
		const reclaim = new PiContextBudget(0, () => now);
		now = 3_200;
		reclaim.completed = true;
		recordPendingPiTransformDecision(
			sessionId,
			reclaimDecision,
			"a-before",
			reclaim.assertDecisionPublication,
		);
		// The user reads the answer and replies half a minute later.
		now = 30_000;

		expect(await resolveOnNextPass(db, sessionId)).toEqual([
			"pi:a-reclaim:execute",
		]);
	});
});

test("a pass that crossed its outcome deadline still records no decision row", async () => {
	const sessionId = "ses-pi-reclaim-decision-expired";
	await withThrowawayDb("mc-pi-decision-expired-", async (db) => {
		let now = 0;
		const expired = new PiContextBudget(0, () => now);
		now = 3_200;
		recordPendingPiTransformDecision(
			sessionId,
			reclaimDecision,
			"a-before",
			expired.assertDecisionPublication,
		);
		// The handler never returned inside its 25 s window, so no request went
		// out on its result.
		now = 26_000;

		expect(await resolveOnNextPass(db, sessionId)).toEqual([]);
	});
});
