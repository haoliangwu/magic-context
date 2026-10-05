import { describe, expect, it } from "bun:test";
import { resolveProjectIdentity } from "@magic-context/core/features/magic-context/memory/project-identity";
import { updateSessionMeta } from "@magic-context/core/features/magic-context/storage";
import { closeQuietly } from "@magic-context/core/shared/sqlite-helpers";
import { buildPiStatusDetail } from "./dialogs/status-dialog";
import { persistPiPressureFromMessageEnd } from "./index";
import {
	isPiContextUsageRawBranchEstimate,
	resolvePiPressureSnapshotWithEstimateGuard,
} from "./pi-pressure";
import { recordPiProvenFloorModel } from "./pi-proven-floor";
import { renderStatusText } from "./status-line";
import { createTestDb, fakeContext } from "./test-utils.test";

// Replays the figures from a Pi session on openai-codex/gpt-6.1-sol (500K
// window from the user's model override, 128K output). The provider returned a
// transient "overloaded" error, and Pi appended a `context_edit` to hide the
// failed attempt before retrying. Until the retry's response arrived, Pi's
// getContextUsage() re-estimated the whole unreduced session branch at
// 989,562 tokens. Magic Context's last provider reading was 237,913 against a
// 786,172-token usable limit (30.3%). The transform set the estimate aside;
// the status displays used to take max(persisted, live) and showed 125.9%.

const MODEL = {
	provider: "openai-codex",
	id: "gpt-6.1-sol",
	contextWindow: 500_000,
	maxTokens: 128_000,
};
const PERSISTED_INPUT = 237_913;
const USABLE_LIMIT = 786_172;
const RAW_BRANCH_ESTIMATE = 989_562;

type Entry = { type: string; id: string; message?: Record<string, unknown> };

/**
 * Pi's per-message character estimate (chars / 4, rounded up), restricted to
 * the text content the fixture uses. pi-coding-agent 0.99.2
 * `dist/core/compaction/compaction.js` `estimateTokens`.
 */
function piEstimateMessageTokens(message: Record<string, unknown>): number {
	const content = message.content;
	const text = Array.isArray(content)
		? content
				.map((part) =>
					typeof (part as { text?: unknown }).text === "string"
						? (part as { text: string }).text
						: "",
				)
				.join("")
		: typeof content === "string"
			? content
			: "";
	return Math.ceil(text.length / 4);
}

function usageTotal(usage: Record<string, number>): number {
	return (
		usage.totalTokens ||
		usage.input + usage.output + usage.cacheRead + usage.cacheWrite
	);
}

/**
 * A model of Pi's `AgentSession.getContextUsage().tokens`
 * (pi-coding-agent 0.99.2 `dist/core/agent-session.js:3371-3398`), which calls
 * `estimateProjectedContextTokens(projection, branch)`
 * (`dist/core/compaction/compaction.js:135-174`). The installed Pi in this
 * repository (0.83.0) predates `context_edit`, so the rule is reproduced here:
 * the newest assistant with usable usage (not aborted or errored) anchors the
 * figure, plus an estimate of the messages after it, unless a `context_edit`
 * or `compaction` entry is newer than that assistant. Then every projected
 * message is re-estimated from characters, and that projection is the raw,
 * unreduced branch.
 */
function piContextUsageTokens(branch: readonly Entry[]): number {
	let usageIndex = -1;
	let invalidatedAt = -1;
	for (let index = branch.length - 1; index >= 0; index -= 1) {
		const entry = branch[index];
		if (
			invalidatedAt < 0 &&
			(entry.type === "context_edit" || entry.type === "compaction")
		) {
			invalidatedAt = index;
		}
		const message = entry.message;
		if (
			usageIndex < 0 &&
			entry.type === "message" &&
			message?.role === "assistant" &&
			message.stopReason !== "aborted" &&
			message.stopReason !== "error" &&
			message.usage &&
			usageTotal(message.usage as Record<string, number>) > 0
		) {
			usageIndex = index;
		}
	}
	const messages = branch.filter(
		(entry): entry is Entry & { message: Record<string, unknown> } =>
			entry.type === "message" && entry.message !== undefined,
	);
	if (usageIndex < 0 || invalidatedAt > usageIndex) {
		return messages.reduce(
			(sum, entry) => sum + piEstimateMessageTokens(entry.message),
			0,
		);
	}
	const anchor = branch[usageIndex].message as {
		usage: Record<string, number>;
	};
	return (
		usageTotal(anchor.usage) +
		branch
			.slice(usageIndex + 1)
			.filter((entry) => entry.type === "message" && entry.message)
			.reduce(
				(sum, entry) =>
					sum +
					piEstimateMessageTokens(entry.message as Record<string, unknown>),
				0,
			)
	);
}

/**
 * The branch as it stood between the failed attempt and the successful retry:
 * the raw history (sized so Pi's character estimate is exactly 989,562), the
 * last successful assistant row, the attempt that failed with a zero-usage
 * error, the `context_edit` that hides it, and the queued user message.
 */
function incidentBranch(retried: boolean): Entry[] {
	const branch: Entry[] = [
		{
			type: "message",
			id: "raw-history",
			message: {
				role: "user",
				content: [{ type: "text", text: "x".repeat(RAW_BRANCH_ESTIMATE * 4) }],
			},
		},
		{
			type: "message",
			id: "last-success",
			message: {
				role: "assistant",
				content: [],
				stopReason: "stop",
				usage: {
					input: 108,
					cacheRead: 237_805,
					cacheWrite: 0,
					output: 700,
					totalTokens: 238_613,
				},
			},
		},
	];
	if (retried) {
		branch.push(
			{
				type: "message",
				id: "ee089e50",
				message: {
					role: "assistant",
					content: [],
					stopReason: "error",
					errorMessage:
						"Codex error: Our servers are currently overloaded. Please try again later.",
					usage: {
						input: 0,
						cacheRead: 0,
						cacheWrite: 0,
						output: 0,
						totalTokens: 0,
					},
				},
			},
			{ type: "context_edit", id: "edit-1" },
			{
				type: "message",
				id: "queued",
				message: { role: "user", content: [] },
			},
		);
	}
	return branch;
}

function incidentContext(sessionId: string, retried: boolean) {
	const branch = incidentBranch(retried);
	const base = fakeContext(sessionId);
	return {
		branch,
		ctx: {
			...base,
			model: MODEL,
			sessionManager: { ...base.sessionManager, getBranch: () => branch },
			getContextUsage: () => {
				const tokens = piContextUsageTokens(branch);
				return {
					tokens,
					percent: (tokens / MODEL.contextWindow) * 100,
					contextWindow: MODEL.contextWindow,
				};
			},
			getSystemPrompt: () => "system prompt",
		},
	};
}

/**
 * The session state before the failed attempt: the last provider reading,
 * 237,913 tokens at 30.3% of a 786,172-token usable limit. That limit is a
 * proven input floor, recorded here for the model in use.
 */
function seedPersistedReading(db: ReturnType<typeof createTestDb>, id: string) {
	updateSessionMeta(db, id, {
		lastInputTokens: PERSISTED_INPUT,
		lastContextPercentage: (PERSISTED_INPUT / USABLE_LIMIT) * 100,
		lastUsageContextLimit: USABLE_LIMIT,
		observedSafeInputTokens: USABLE_LIMIT,
	});
	recordPiProvenFloorModel(
		db,
		id,
		`${MODEL.provider}/${MODEL.id}`,
		USABLE_LIMIT,
	);
}

/** What index.ts does on Pi's message_end, with the modelled Pi context. */
function messageEnd(
	db: ReturnType<typeof createTestDb>,
	sessionId: string,
	ctx: ReturnType<typeof incidentContext>["ctx"],
	message: unknown,
) {
	const usage = ctx.getContextUsage();
	return persistPiPressureFromMessageEnd({
		db,
		sessionId,
		message,
		piContextWindow: usage.contextWindow,
		piContextWindowSource: "catalog",
		piModel: MODEL,
		piTokens: usage.tokens,
		piTokensIsRawBranchEstimate: isPiContextUsageRawBranchEstimate(
			ctx.sessionManager,
		),
	});
}

const QUEUED_PROMPT = {
	role: "user",
	content: "Don't use any workers, we want direct audit.",
};

describe("Pi status displays after a retried request", () => {
	it("the modelled Pi figure is the raw-branch estimate only after the context edit", () => {
		expect(
			incidentContext("ses-model-check", true).ctx.getContextUsage().tokens,
		).toBe(RAW_BRANCH_ESTIMATE);
		expect(
			incidentContext("ses-model-check", false).ctx.getContextUsage().tokens,
		).toBe(238_613);
	});

	it("/ctx-status shows the transform's guarded 30%, not 125.9%", async () => {
		const db = createTestDb();
		try {
			const sessionId = "ses-status-raw-branch";
			seedPersistedReading(db, sessionId);
			const { ctx } = incidentContext(sessionId, true);
			await messageEnd(db, sessionId, ctx, QUEUED_PROMPT);

			const detail = buildPiStatusDetail(
				{ getAllTools: () => [] } as never,
				ctx as never,
				{ db, projectIdentity: resolveProjectIdentity(process.cwd()) },
				sessionId,
			);

			expect(detail.contextLimit).toBe(USABLE_LIMIT);
			expect(detail.inputTokens).toBe(PERSISTED_INPUT);
			expect(detail.usagePercentage).toBeCloseTo(30.26, 1);

			// The token figure the context transform's pressure decision uses on
			// the pass that sends the retried request.
			const transform = resolvePiPressureSnapshotWithEstimateGuard({
				sessionId,
				source: "transform",
				liveIsRawBranchEstimate: true,
				persistedPercentage: (PERSISTED_INPUT / USABLE_LIMIT) * 100,
				persistedInputTokens: PERSISTED_INPUT,
				liveInputTokens: RAW_BRANCH_ESTIMATE,
				usableContextLimit: USABLE_LIMIT,
			});
			expect(detail.inputTokens).toBe(transform.inputTokens);
			expect(detail.usagePercentage).toBe(transform.percentage);
		} finally {
			closeQuietly(db);
		}
	});

	it("the footer shows 30%, not 125.9%, until the retry's reply restores the live figure", async () => {
		const db = createTestDb();
		try {
			const sessionId = "ses-footer-raw-branch";
			seedPersistedReading(db, sessionId);
			const { ctx, branch } = incidentContext(sessionId, true);
			await messageEnd(db, sessionId, ctx, QUEUED_PROMPT);
			const text = renderStatusText(ctx as never, db, sessionId);
			expect(text).toContain("mc: 237.9K (30%)");
			expect(text).not.toContain("989.6K");

			// The retried request succeeds. Pi emits message_end before it
			// appends the reply to the branch.
			const reply = {
				role: "assistant",
				content: [],
				provider: MODEL.provider,
				model: MODEL.id,
				stopReason: "stop",
				usage: {
					input: 108,
					cacheRead: 238_208,
					cacheWrite: 0,
					output: 847,
					totalTokens: 239_163,
				},
			};
			await messageEnd(db, sessionId, ctx, reply);
			branch.push({ type: "message", id: "retry-reply", message: reply });
			expect(renderStatusText(ctx as never, db, sessionId)).toContain(
				"mc: 239.2K (30%)",
			);
		} finally {
			closeQuietly(db);
		}
	});

	it("a live figure anchored on provider usage still wins when it is larger", async () => {
		const db = createTestDb();
		try {
			const sessionId = "ses-footer-usage-anchored";
			seedPersistedReading(db, sessionId);
			const { ctx } = incidentContext(sessionId, false);
			await messageEnd(db, sessionId, ctx, QUEUED_PROMPT);
			expect(renderStatusText(ctx as never, db, sessionId)).toContain(
				"mc: 238.6K (30%)",
			);
		} finally {
			closeQuietly(db);
		}
	});
});
