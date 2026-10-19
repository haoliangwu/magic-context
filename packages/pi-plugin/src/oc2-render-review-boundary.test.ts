import { expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendCompartments } from "@magic-context/core/features/magic-context/compartment-storage";
import { getOrCreateSessionMeta } from "@magic-context/core/features/magic-context/storage-meta";
import { withRawMessageProvider } from "@magic-context/core/hooks/magic-context/read-session-chunk";
import {
	materializeM0Pi,
	trimPiMessagesToCachedBoundary,
} from "./inject-compartments-pi";
import { createTestDb, userMessage } from "./test-utils.test";

test("render review: Pi omitted boundary preserves cached-prefix replay bytes", () => {
	const db = createTestDb();
	const sessionId = "render-review-pi-boundary";
	try {
		appendCompartments(db, sessionId, [
			{
				sequence: 0,
				startMessage: 1,
				endMessage: 2,
				startMessageId: "old",
				endMessageId: "boundary",
				title: "Summary",
				content: "Old history.",
			},
		]);
		materializeM0Pi(
			{
				sessionId,
				projectDirectory: join(
					tmpdir(),
					"magic-context/oc2-render-review/empty-project",
				),
			},
			db,
		);
		const before = getOrCreateSessionMeta(db, sessionId);
		withRawMessageProvider(
			sessionId,
			{
				readMessages: () =>
					["old", "boundary", "tail"].map((id, n) => ({
						id,
						role: "user" as const,
						ordinal: n + 1,
						parts: [{ type: "text", text: id }],
					})),
			},
			() => {
				const full = [
					userMessage("old"),
					userMessage("boundary"),
					userMessage("tail"),
				];
				trimPiMessagesToCachedBoundary(db, sessionId, full, [
					"old",
					"boundary",
					"tail",
				]);
				expect(full).toEqual([userMessage("tail")]);
				for (let pass = 0; pass < 3; pass++) {
					const omitted = [userMessage("old"), userMessage("tail")];
					trimPiMessagesToCachedBoundary(db, sessionId, omitted, [
						"old",
						"tail",
					]);
					expect(getOrCreateSessionMeta(db, sessionId).cachedM0Bytes).toEqual(
						before.cachedM0Bytes,
					);
					expect(getOrCreateSessionMeta(db, sessionId).cachedM0SystemHash).toBe(
						before.cachedM0SystemHash,
					);
					expect(
						JSON.stringify(omitted),
						`cached-prefix replay pass ${pass}`,
					).toBe(JSON.stringify(full));
				}
			},
		);
	} finally {
		db.close();
	}
});
