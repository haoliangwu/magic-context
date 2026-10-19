import { expect, test } from "bun:test";
import {
	getPendingOps,
	getTagsBySession,
	queuePendingOp,
	updateSessionMeta,
} from "@magic-context/core/features/magic-context/storage";
import {
	clearContextHandlerSession,
	registerPiContextHandler,
	signalPiHistoryRefresh,
	signalPiPendingMaterialization,
	signalPiSystemHashChange,
} from "./context-handler";
import {
	assistantMessage,
	assistantToolCall,
	createFakePi,
	createTestDb,
	fakeContext,
	toolResultMessage,
	userMessage,
} from "./test-utils.test";

function harness(inject = false) {
	const db = createTestDb();
	const id = "effective-system-evidence";
	const fake = createFakePi();
	registerPiContextHandler(fake.pi as never, {
		db,
		protectedTags: 0,
		injection: inject
			? {
					injectionBudgetTokens: 40_000,
					memoryEnabled: false,
					injectDocs: false,
				}
			: undefined,
	});
	const raw = [userMessage("request", 1), assistantMessage("response", 2)];
	for (let i = 0; i < 16; i++) {
		raw.push(
			userMessage(`request ${i}`, 3 + i * 4),
			assistantToolCall(`call-${i}`, "Read", { path: `${i}.txt` }, 4 + i * 4),
			toolResultMessage(`call-${i}`, `Result ${i}.\n`.repeat(10), 5 + i * 4),
			assistantMessage(`response ${i}`, 6 + i * 4),
		);
	}
	return {
		db,
		id,
		async pass(getSystemPrompt?: () => unknown) {
			updateSessionMeta(db, id, {
				lastResponseTime: Date.now(),
				cacheTtl: "59m",
				lastContextPercentage: 64,
				lastInputTokens: 64_000,
			});
			const messages = structuredClone(raw);
			const ctx = {
				...fakeContext(
					id,
					process.cwd(),
					messages.map((_, i) => `entry-${i}`),
					messages,
				),
				...(getSystemPrompt ? { getSystemPrompt } : {}),
				getContextUsage: () => ({
					tokens: 64_000,
					percent: 64,
					contextWindow: 100_000,
				}),
			};
			const result = await fake.handlers.get("context")?.(
				{ messages } as never,
				ctx as never,
			);
			if (!result) throw new Error("context handler did not return messages");
			return structuredClone(result);
		},
		queue() {
			const target = getTagsBySession(db, id).find(
				(t) => t.messageId === "call-2",
			);
			if (!target) throw new Error("missing tool result");
			queuePendingOp(db, id, target.tagNumber, "drop");
		},
		close() {
			clearContextHandlerSession(id);
			db.close();
		},
	};
}

test("an unavailable effective system prompt never admits a drop on metadata alone", async () => {
	const h = harness();
	try {
		const previous = await h.pass();
		h.queue();
		updateSessionMeta(h.db, h.id, {
			systemPromptHash: "changed-upstream-metadata",
		});
		signalPiSystemHashChange(h.id, "changed-upstream-metadata");
		expect(await h.pass()).toEqual(previous);
		expect(getPendingOps(h.db, h.id)).toHaveLength(1);
		signalPiHistoryRefresh(h.id);
		signalPiPendingMaterialization(h.id);
		expect(await h.pass()).not.toEqual(previous);
		expect(getPendingOps(h.db, h.id)).toHaveLength(0);
	} finally {
		h.close();
	}
});

test("effective segmented system prompts compare normalized bytes, not upstream metadata", async () => {
	const h = harness();
	try {
		const previous = await h.pass(() => ["Contract", "Project"]);
		h.queue();
		expect(await h.pass(() => "Contract\n\nProject")).toEqual(previous);
		expect(getPendingOps(h.db, h.id)).toHaveLength(1);
		expect(await h.pass(() => ["Contract", "Changed project"])).not.toEqual(
			previous,
		);
		expect(getPendingOps(h.db, h.id)).toHaveLength(0);
	} finally {
		h.close();
	}
});

test("an unavailable served prompt clears evidence rather than inventing a later change", async () => {
	const h = harness();
	try {
		const previous = await h.pass(() => "Known prompt");
		h.queue();
		expect(await h.pass(() => undefined)).toEqual(previous);
		expect(await h.pass(() => "Newly available prompt")).toEqual(previous);
		expect(getPendingOps(h.db, h.id)).toHaveLength(1);
		expect(await h.pass(() => "An observed change")).not.toEqual(previous);
		expect(getPendingOps(h.db, h.id)).toHaveLength(0);
	} finally {
		h.close();
	}
});

test("a metadata-only system fold cannot admit drops with history injection enabled", async () => {
	const h = harness(true);
	try {
		const previous = await h.pass(() => "Final host prompt");
		h.queue();
		updateSessionMeta(h.db, h.id, { systemPromptHash: "upstream-only-change" });
		signalPiSystemHashChange(h.id, "upstream-only-change");
		expect(await h.pass(() => "Final host prompt")).toEqual(previous);
		expect(getPendingOps(h.db, h.id)).toHaveLength(1);
		expect(await h.pass(() => "Actually changed final prompt")).not.toEqual(
			previous,
		);
		expect(getPendingOps(h.db, h.id)).toHaveLength(0);
	} finally {
		h.close();
	}
});
