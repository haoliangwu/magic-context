/// <reference types="bun-types" />

import { describe, expect, it } from "bun:test";
import { Type } from "typebox";
import { createPiDroppedInputGuard } from "./dropped-input-guard-pi";

const blockedInputs: Array<[string, Record<string, unknown>]> = [
	["tagged drop sentinel", { command: "[dropped §431§]" }],
	["legacy truncation", { command: "which...[truncated]" }],
	["legacy array summary", { files: "[3 items]" }],
	["legacy object summary", { metadata: "[object]" }],
	["new dropped marker", { dropped: "[dropped §431§]" }],
];

const writeParameters = Type.Object({
	path: Type.String(),
	content: Type.String(),
	append: Type.Optional(Type.Boolean()),
});

function sessionContext(id: string) {
	return { sessionManager: { getSessionId: () => id } } as never;
}

describe("Pi dropped input execution guard", () => {
	for (const [label, input] of blockedInputs) {
		it(`blocks the ${label}`, () => {
			const result = createPiDroppedInputGuard()({
				type: "tool_call",
				toolCallId: "call-431",
				toolName: "write",
				input,
			});

			expect(result).toEqual({
				block: true,
				reason: expect.stringContaining(
					`your arguments to \`write\` were ${JSON.stringify(input)}`,
				),
			});
		});
	}

	it("lists the tool's real parameters from its schema, required first", () => {
		const result = createPiDroppedInputGuard({
			parametersFor: (name) => (name === "write" ? writeParameters : undefined),
		})({
			type: "tool_call",
			toolCallId: "call-768",
			toolName: "write",
			input: { dropped: "[dropped §768§]" },
		});

		expect(result?.reason).toContain(
			"the placeholder Magic Context shows in place of an earlier call's arguments",
		);
		expect(result?.reason).toContain(
			"its parameters: path (required), content (required), append.",
		);
	});

	it("counts consecutive refusals per session and resets on an accepted call", () => {
		const guard = createPiDroppedInputGuard();
		const refused = {
			type: "tool_call" as const,
			toolCallId: "call",
			toolName: "read",
			input: { dropped: "[dropped §770§]" },
		};

		expect(guard(refused, sessionContext("pi-a"))?.reason).not.toContain(
			"in a row",
		);
		expect(guard(refused, sessionContext("pi-a"))?.reason).toContain(
			"This is the 2nd call in a row with placeholder arguments.",
		);
		expect(guard(refused, sessionContext("pi-b"))?.reason).not.toContain(
			"in a row",
		);
		expect(
			guard(
				{ ...refused, input: { path: "README.md" } },
				sessionContext("pi-a"),
			),
		).toBeUndefined();
		expect(guard(refused, sessionContext("pi-a"))?.reason).not.toContain(
			"in a row",
		);
	});

	it("allows ordinary executable arguments", () => {
		const result = createPiDroppedInputGuard()({
			type: "tool_call",
			toolCallId: "call-clean",
			toolName: "bash",
			input: { command: "which docker" },
		});

		expect(result).toBeUndefined();
	});
});
