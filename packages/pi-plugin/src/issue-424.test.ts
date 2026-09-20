import { registerIssue424Tests } from "@magic-context/core/hooks/magic-context/issue-424-test-support.test";
import { convertEntriesToRawMessages } from "./read-session-pi";

registerIssue424Tests("pi", (fixture) =>
	convertEntriesToRawMessages(fixture.entries),
);

import { registerIssue424CapacityTests } from "@magic-context/core/hooks/magic-context/issue-424-capacity-test-support.test";
import { runPiHistorian } from "./pi-historian-runner";

registerIssue424CapacityTests(
	"pi",
	(fixture) => convertEntriesToRawMessages(fixture.entries),
	async ({
		db,
		sessionId,
		raw,
		boundary,
		xml,
		holderId,
		historianChunkTokens,
		historianContextLimit,
		maxOutputTokens,
	}) => {
		const prompts: string[] = [];
		await runPiHistorian({
			db,
			sessionId,
			directory: process.cwd(),
			provider: { readMessages: () => raw },
			runner: {
				run: async (options) => {
					prompts.push(options.userMessage);
					return { ok: true, assistantText: xml, durationMs: 1 };
				},
			},
			historianModel: "test/model",
			historianChunkTokens,
			historianContextLimit,
			maxOutputTokens,
			boundarySnapshot: boundary,
			compartmentLeaseHolderId: holderId,
			memoryEnabled: false,
		});
		return prompts;
	},
);
