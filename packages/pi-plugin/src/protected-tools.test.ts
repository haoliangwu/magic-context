import { describe, it } from "bun:test";
import {
	cases,
	checkProtectedToolsCase,
} from "@magic-context/core/hooks/magic-context/protected-tools-fixture.test";
import { applyPiHeuristicCleanup } from "./heuristic-cleanup-pi";

describe("protected_tools selection golden (Pi)", () => {
	for (const spec of cases)
		it(spec.label, () =>
			checkProtectedToolsCase(
				spec,
				(sessionId, db, targets, _messages, config) => {
					const messages = [
						{
							role: "assistant",
							timestamp: 1,
							content: spec.tools.map((name, i) => ({
								type: "toolCall",
								id: `call-${i}`,
								name,
								arguments: { filePath: "same" },
							})),
						},
					];
					const result = applyPiHeuristicCleanup(
						sessionId,
						db,
						targets,
						messages,
						{ ...config, protectedTags: 0 },
						undefined,
						() => "owner",
					);
					return { ...result, compressedTextTags: 0, mutatedTextTags: 0 };
				},
			),
		);
});
