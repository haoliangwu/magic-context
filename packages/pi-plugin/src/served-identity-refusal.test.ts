import { expect, spyOn, test } from "bun:test";
import {
	getSlot,
	resetLkgSlotsForTest,
} from "@magic-context/core/hooks/magic-context/lkg-slot";
import * as storagePermissions from "@magic-context/core/shared/storage-permissions";
import {
	clearContextHandlerSession,
	registerPiContextHandler,
} from "./context-handler";
import { readPiCommittedServedNumbers } from "./pi-served-identities";
import { observePiPublicationForTest } from "./publication-observer-fixture.test";
import * as ledger from "./served-array-ledger";
import {
	createFakePi,
	createTestDb,
	fakeContext,
	userMessage,
} from "./test-utils.test";

test("identity mirror failure serves the committed pair and repairs the mirror on the next pass", async () => {
	const db = createTestDb();
	const sessionId = "served-identity-persistence-refusal";
	const fake = createFakePi();
	Object.assign(fake.pi, {
		getAllTools: () => [
			{
				name: "ctx_reduce",
				description: "reduce context",
				parameters: { type: "object" },
			},
		],
		getActiveTools: () => ["ctx_reduce"],
	});
	registerPiContextHandler(fake.pi as never, { db });
	const handler = fake.handlers.get("context") as unknown as (
		event: { messages: ReturnType<typeof userMessage>[] },
		ctx: ReturnType<typeof fakeContext>,
	) => Promise<{ messages: unknown[] }>;
	const context = (raw: ReturnType<typeof userMessage>[]) =>
		Object.assign(
			fakeContext(
				sessionId,
				process.cwd(),
				raw.map((_, index) => `u${index}`),
				raw,
			),
			{
				getSystemPrompt: () => "You are a coding assistant.",
				model: {
					provider: "anthropic",
					id: "claude-sonnet-4-20250514",
					api: "anthropic-messages",
					contextWindow: 100000,
					maxTokens: 8192,
				},
			},
		);
	const publication = observePiPublicationForTest(sessionId);
	let capture: ReturnType<typeof spyOn> | undefined;
	try {
		const first = [userMessage("already served", 1)];
		await handler({ messages: structuredClone(first) }, context(first));
		await Bun.sleep(50);
		expect(getSlot(sessionId)).toBeDefined();
		publication.reset();
		const write = storagePermissions.writeStorageFileSync;
		const identityPath = ledger.getPiServedTagNumbersPath(sessionId);
		let identityAttempts = 0;
		capture = spyOn(
			storagePermissions,
			"writeStorageFileSync",
		).mockImplementation((path, ...args) => {
			if (path === identityPath && ++identityAttempts === 1)
				throw new Error("identity mirror disk unavailable");
			return write(path, ...args);
		});
		const raw = [...first, userMessage("served despite mirror failure", 2)];
		const served = await handler(
			{ messages: structuredClone(raw) },
			context(raw),
		);
		expect(JSON.stringify(served.messages)).toContain(
			"§2§ served despite mirror failure",
		);
		expect(identityAttempts).toBe(1);
		await Bun.sleep(50);
		// The request and identities already committed. An optional mirror failure
		// must neither block the managed result nor discard its authoritative pair.
		expect(getSlot(sessionId)?.jsonPrefix).toContain(
			"served despite mirror failure",
		);
		expect(readPiCommittedServedNumbers(db, sessionId)).toEqual([1, 2]);
		expect([...ledger.getPiServedTagNumbers(sessionId)]).toEqual([1]);
		publication.expect("mirror_failed", "identity_mirror_failed", 1, 1);
		const repaired = await handler(
			{ messages: structuredClone(raw) },
			context(raw),
		);
		expect(repaired.messages).toEqual(served.messages);
		expect(identityAttempts).toBe(2);
		expect([...ledger.getPiServedTagNumbers(sessionId)]).toEqual([1, 2]);
	} finally {
		capture?.mockRestore();
		publication.restore();
		clearContextHandlerSession(sessionId);
		resetLkgSlotsForTest();
		db.close();
	}
});
