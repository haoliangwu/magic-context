import { expect, it } from "bun:test";
import {
	getOrCreateSessionMeta,
	updateSessionMeta,
} from "@magic-context/core/features/magic-context/storage-meta";
import { persistPiPressureFromMessageEnd } from "./index";
import {
	acknowledgePiSystemPromptResponse,
	beginPiSystemPromptRequest,
	clearPiSystemPromptDelivery,
	recordPiHeldSystemHead,
} from "./system-prompt-delivery-pi";
import { createTestDb } from "./test-utils.test";

let counter = 0;
function fixture() {
	const db = createTestDb();
	const sessionId = `pi-delivery-provenance-${++counter}`;
	getOrCreateSessionMeta(db, sessionId);
	updateSessionMeta(db, sessionId, {
		cachedM0SystemHash: "old",
		systemPromptHash: "undispatched-new",
	});
	return {
		db,
		sessionId,
		hash: () => getOrCreateSessionMeta(db, sessionId).cachedM0SystemHash,
		close: () => {
			clearPiSystemPromptDelivery(sessionId);
			db.close();
		},
	};
}
const reply = (model = "claude-opus-5-5") => ({
	role: "assistant",
	timestamp: 101,
	provider: "anthropic",
	model,
	stopReason: "stop",
	usage: { input: 1000, output: 10, cacheRead: 0, cacheWrite: 0 },
});

it("system delivery: Pi same-model side reply cannot acknowledge undispatched primary bytes", async () => {
	const f = fixture();
	const now = Date.now;
	Date.now = () => 100;
	try {
		beginPiSystemPromptRequest(f.db, f.sessionId, "anthropic/claude-opus-5-5");
		recordPiHeldSystemHead(f.sessionId, () => {});
		await persistPiPressureFromMessageEnd({
			db: f.db,
			sessionId: f.sessionId,
			piContextWindow: 200000,
			message: reply(),
		});
		expect(f.hash()).toBe("old");
	} finally {
		Date.now = now;
		f.close();
	}
});

it("system delivery: Pi model mismatch and session deletion reject a late reply", () => {
	const f = fixture();
	const now = Date.now;
	Date.now = () => 100;
	try {
		const message = reply("claude-opus-5-4");
		const branch = [
			{ type: "message", id: "response", parentId: "primary-input", message },
		];
		beginPiSystemPromptRequest(f.db, f.sessionId, "anthropic/claude-opus-5-5", {
			parentId: "primary-input",
			readBranch: () => branch,
		});
		recordPiHeldSystemHead(f.sessionId, () => {});
		acknowledgePiSystemPromptResponse(f.sessionId, message);
		expect(f.hash()).toBe("old");
		clearPiSystemPromptDelivery(f.sessionId);
		acknowledgePiSystemPromptResponse(f.sessionId, reply());
		expect(f.hash()).toBe("old");
	} finally {
		Date.now = now;
		f.close();
	}
});

it("system delivery: only an appended primary reply owns the held request", () => {
	const f = fixture();
	const now = Date.now;
	Date.now = () => 100;
	const branch: unknown[] = [];
	try {
		beginPiSystemPromptRequest(f.db, f.sessionId, "anthropic/claude-opus-5-5", {
			parentId: "primary-input",
			readBranch: () => branch,
		});
		recordPiHeldSystemHead(f.sessionId, () => {});
		const side = reply();
		acknowledgePiSystemPromptResponse(f.sessionId, side);
		expect(f.hash()).toBe("old");
		// A cloned or differently parented message is not proof of this reply.
		branch.push({
			type: "message",
			id: "side",
			parentId: "side-input",
			message: side,
		});
		acknowledgePiSystemPromptResponse(f.sessionId, side);
		expect(f.hash()).toBe("old");
		const primary = reply();
		acknowledgePiSystemPromptResponse(f.sessionId, primary);
		expect(f.hash()).toBe("old");
		branch.push({
			type: "message",
			id: "primary-response",
			parentId: "primary-input",
			message: primary,
		});
		Date.now = () => 200;
		beginPiSystemPromptRequest(f.db, f.sessionId, "anthropic/claude-opus-5-5", {
			parentId: "primary-response",
			readBranch: () => branch,
		});
		expect(f.hash()).toBe("undispatched-new");
	} finally {
		Date.now = now;
		f.close();
	}
});
