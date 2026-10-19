import { afterEach, expect, mock, spyOn, test } from "bun:test";
import * as logger from "@magic-context/core/shared/logger";
import {
	clearPiContextReceipt,
	registerPiGuardedContext,
} from "./pi-context-refusal";
import {
	piPreparedStructure,
	piPreparedStructureMismatch,
} from "./pi-dispatch-structure";
import { __setPiHarnessKindForTesting } from "./pi-harness-kind";
import { fakeContext, userMessage } from "./test-utils.test";

const secrets = [
	"PRIVATE_MESSAGE_TEXT",
	"PRIVATE_EXPECTED_ID",
	"PRIVATE_ACTUAL_ID",
	"PRIVATE_TOOL_NAME",
	"PRIVATE_ARGUMENT",
];
const managed: Record<string, unknown>[] = [
	{
		...userMessage(
			"<session-history>PRIVATE_MESSAGE_TEXT</session-history>",
			1,
		),
	},
	{
		role: "assistant",
		content: [
			{
				type: "toolCall",
				id: secrets[1],
				name: secrets[3],
				arguments: { private: secrets[4] },
			},
		],
		timestamp: 2,
	},
	{
		role: "toolResult",
		toolCallId: secrets[1],
		toolName: secrets[3],
		content: [{ type: "text", text: secrets[0] }],
		timestamp: 3,
	},
	{ ...userMessage("latest prompt", 4) },
];
const prepared = piPreparedStructure(managed);
function mismatch(value: unknown, expected = prepared): string {
	const detail = piPreparedStructureMismatch(value, expected);
	if (!detail) throw new Error("expected structure mismatch");
	return detail;
}

const payload = () => ({ messages: structuredClone(managed) });

afterEach(() => {
	mock.restore();
	clearPiContextReceipt("structure-diagnostic");
	__setPiHarnessKindForTesting(undefined);
});

test("dispatch divergence: identical structure has no diagnostic", () => {
	expect(piPreparedStructureMismatch(payload(), prepared)).toBeUndefined();
});

test("dispatch divergence: first role mismatch includes normalized row metadata", () => {
	const changed = payload();
	changed.messages[1] = { role: "user", content: "other", timestamp: 2 };
	expect(piPreparedStructureMismatch(changed, prepared)).toBe(
		"row=1 expectedRows=4 actualRows=4 expectedRole=assistant actualRole=user expectedCalls=1 actualCalls=0 expectedResults=0 actualResults=0 comparison=role",
	);
});

test("dispatch divergence: missing tail and call count have explicit counts", () => {
	expect(
		piPreparedStructureMismatch({ messages: managed.slice(0, 3) }, prepared),
	).toBe(
		"row=3 expectedRows=4 actualRows=3 expectedRole=user actualRole=missing expectedCalls=0 actualCalls=0 expectedResults=0 actualResults=0 comparison=count",
	);
	const changed = payload();
	changed.messages[1] = { role: "assistant", content: [], timestamp: 2 };
	expect(piPreparedStructureMismatch(changed, prepared)).toContain(
		"row=1 expectedRows=4 actualRows=4 expectedRole=assistant actualRole=assistant expectedCalls=1 actualCalls=0",
	);
	expect(piPreparedStructureMismatch(changed, prepared)).toContain(
		"comparison=count",
	);
});

test("dispatch divergence: id, name and timestamp reasons never contain their values", () => {
	const call = payload();
	(call.messages[1].content as { id: string }[])[0].id = secrets[2];
	expect(piPreparedStructureMismatch(call, prepared)).toContain("row=1");
	expect(piPreparedStructureMismatch(call, prepared)).toContain(
		"comparison=call id",
	);
	const result = payload();
	result.messages[2].toolCallId = secrets[2];
	expect(piPreparedStructureMismatch(result, prepared)).toContain("row=2");
	expect(piPreparedStructureMismatch(result, prepared)).toContain(
		"comparison=result id",
	);
	const google = {
		contents: [
			{ role: "user", parts: [{ text: secrets[0] }] },
			{
				role: "model",
				parts: [{ functionCall: { name: "OTHER_PRIVATE_NAME" } }],
			},
			{ role: "user", parts: [{ functionResponse: { name: secrets[3] } }] },
			{ role: "user", parts: [{ text: "latest" }] },
		],
	};
	expect(piPreparedStructureMismatch(google, prepared)).toContain(
		"comparison=name",
	);
	const timestamp = payload();
	timestamp.messages[3].timestamp = 999;
	expect(piPreparedStructureMismatch(timestamp, prepared)).toContain(
		"comparison=timestamp",
	);
	for (const value of [call, result, google, timestamp]) {
		const detail = mismatch(value);
		for (const secret of [...secrets, "OTHER_PRIVATE_NAME"])
			expect(detail).not.toContain(secret);
	}
});

test("dispatch divergence: unreadable values and malicious roles cannot leak into metadata", () => {
	const hostile = {
		get messages() {
			throw new Error(secrets[0]);
		},
	};
	const detail = mismatch(hostile);
	expect(detail).toContain("actualRows=unreadable");
	expect(detail).not.toContain(secrets[0]);
	const invalid = { messages: [{ role: secrets[0], calls: [], results: [] }] };
	const sanitized = mismatch(
		{ messages: [userMessage("native", 1)] },
		invalid as never,
	);
	expect(sanitized).toContain("expectedRole=unknown");
	expect(sanitized).not.toContain(secrets[0]);
});

test("dispatch divergence: an exception reports its comparison stage and error class, never its message", () => {
	const hostile = {
		get messages() {
			throw new TypeError(secrets[0]);
		},
	};
	const wire = mismatch(hostile);
	expect(wire).toBe(
		"row=0 expectedRows=unreadable actualRows=unreadable expectedRole=unreadable actualRole=unreadable expectedCalls=unreadable actualCalls=unreadable expectedResults=unreadable actualResults=unreadable comparison=exception stage=wire rows error=TypeError",
	);

	// A throw while walking rows keeps the row it reached and both row counts.
	if (!prepared) throw new Error("prepared structure missing");
	const rows = prepared.messages.map((row) => ({ ...row }));
	Object.defineProperty(rows[1], "wireCalls", {
		get() {
			class PRIVATE_TOOL_NAME extends Error {}
			throw new PRIVATE_TOOL_NAME(secrets[4]);
		},
	});
	const row = mismatch(payload(), { ...prepared, messages: rows });
	expect(row).toBe(
		"row=1 expectedRows=4 actualRows=4 expectedRole=assistant actualRole=assistant expectedCalls=1 actualCalls=1 expectedResults=0 actualResults=0 comparison=exception stage=row comparison error=unknown",
	);
	for (const detail of [wire, row])
		for (const secret of secrets) expect(detail).not.toContain(secret);
});

test("dispatch divergence: provider refusal appends safe detail without message text, tool names, arguments or IDs", async () => {
	__setPiHarnessKindForTesting("omp");
	const logs: string[] = [];
	spyOn(logger, "log").mockImplementation((message, data) => {
		logs.push(`${message} ${String(data)}`);
	});
	const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
	const refusals: string[] = [];
	const ctx = { ...fakeContext("structure-diagnostic"), abort: () => {} };
	registerPiGuardedContext(
		{
			on: (name: string, handler: (event: unknown, ctx: unknown) => unknown) =>
				handlers.set(name, handler),
			appendEntry: (_type: string, data: { message: string }) =>
				refusals.push(data.message),
		} as never,
		async () => ({ messages: structuredClone(managed) as never }),
	);
	const emit = (name: string, event: unknown = {}) => {
		const handler = handlers.get(name);
		if (!handler) throw new Error(`missing ${name}`);
		return handler(event, ctx);
	};
	emit("agent_start");
	await emit("context", { messages: [userMessage("latest prompt", 4)] });
	const changed = payload();
	(changed.messages[1].content as { id: string }[])[0].id = secrets[2];
	emit("before_provider_request", { payload: changed });
	expect(refusals).toHaveLength(1);
	expect(refusals[0]).toContain(
		"provider request does not match this pass's managed dispatch (prepared turn structure); row=1 expectedRows=4 actualRows=4 expectedRole=assistant actualRole=assistant expectedCalls=1 actualCalls=1 expectedResults=0 actualResults=0 comparison=call id",
	);
	const refusalLog =
		logs.find((line) => line.includes("CONTEXT REFUSED")) ?? "";
	expect(refusalLog).toContain(refusals[0]);
	for (const secret of secrets) {
		expect(refusals[0]).not.toContain(secret);
		expect(refusalLog).not.toContain(secret);
	}
});
