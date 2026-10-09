import { it } from "bun:test";
import {
	checkProtectedToolHold,
	holdCases,
} from "@magic-context/core/hooks/magic-context/protected-tool-holds-fixture.test";
import { fakeContext } from "./test-utils.test";
import { createCtxReduceTool } from "./tools/ctx-reduce";

for (const spec of holdCases)
	it(`Pi held drop: ${spec.label}`, () =>
		checkProtectedToolHold(spec, async (db, sessionId, input) => {
			const result = await createCtxReduceTool({
				db,
				protectedTools: input.protected_tools,
				floor: 4000,
			}).execute(
				"held-call",
				{ drop: String(input.drop) },
				new AbortController().signal,
				undefined,
				fakeContext(sessionId) as never,
			);
			return (result.content[0] as { text: string }).text;
		}));
