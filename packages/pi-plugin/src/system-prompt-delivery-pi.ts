import type { ContextDatabase } from "@magic-context/core/features/magic-context/storage";
import { getOrCreateSessionMeta } from "@magic-context/core/features/magic-context/storage-meta";
import type { LkgRequestIdentity } from "@magic-context/core/hooks/magic-context/lkg-measured-request";
import {
	acknowledgeSystemPromptDelivery,
	bindSystemPromptResponse,
	clearSystemPromptDelivery,
	recordHeldHeadForRequest,
	recordSystemPromptForRequest,
} from "@magic-context/core/hooks/magic-context/system-prompt-delivery";
import { BoundedSessionMap } from "@magic-context/core/shared/bounded-session-map";
import { piModelRefToCanonical } from "@magic-context/core/shared/harness-provider-map";
import {
	isSuccessfulProviderCompletion,
	providerResponseFailed,
} from "@magic-context/core/shared/provider-response-completion";

interface PrimaryBranch {
	parentId: string | null;
	readBranch: () => readonly unknown[] | undefined;
}
interface PreparedPiRequest {
	request: LkgRequestIdentity;
	branch?: PrimaryBranch;
	replies: object[];
}
const requests = new BoundedSessionMap<PreparedPiRequest>(1000);

/** For a normal provider call, remember the final saved conversation entry.
 * A concurrent side call uses a temporary conversation, not that saved input. */
export function beginPiSystemPromptRequest(
	db: ContextDatabase,
	sessionId: string,
	modelKey: string,
	branch?: PrimaryBranch,
): void {
	acknowledgePiPendingSystemPromptResponses(sessionId);
	const request: LkgRequestIdentity = {
		kind: "v2",
		startedAt: Date.now(),
		previousResponseId: undefined,
		modelKey: piModelRefToCanonical(modelKey),
	};
	requests.set(sessionId, { request, branch, replies: [] });
	recordSystemPromptForRequest(
		sessionId,
		request,
		getOrCreateSessionMeta(db, sessionId).systemPromptHash,
		db,
	);
}

export function recordPiHeldSystemHead(
	sessionId: string,
	deferRefresh: (ownsHistory: boolean) => void,
): void {
	recordHeldHeadForRequest(
		sessionId,
		requests.get(sessionId)?.request,
		deferRefresh,
	);
}

/** Pi emits message_end before storing the reply. Keep its exact object until
 * the saved conversation contains that object in an entry whose parentId is
 * the input entry captured for this call. A temporary side conversation does
 * not establish that relationship and cannot acknowledge these instructions. */
export function acknowledgePiSystemPromptResponse(
	sessionId: string,
	message: unknown,
): void {
	const saved = requests.get(sessionId);
	if (
		!saved?.branch ||
		!message ||
		typeof message !== "object" ||
		(message as { role?: unknown }).role !== "assistant"
	)
		return;
	if (!saved.replies.includes(message)) {
		if (saved.replies.length === 32) saved.replies.shift();
		saved.replies.push(message);
	}
	acknowledgePiPendingSystemPromptResponses(sessionId);
}

export function acknowledgePiPendingSystemPromptResponses(
	sessionId: string,
): void {
	const saved = requests.get(sessionId);
	if (!saved?.branch) return;
	let entries: readonly unknown[] | undefined;
	try {
		entries = saved.branch.readBranch();
	} catch {
		return;
	}
	if (!entries) return;
	for (const value of entries) {
		if (!value || typeof value !== "object") continue;
		const entry = value as {
			type?: string;
			id?: string;
			parentId?: string | null;
			message?: object;
		};
		if (
			entry.type !== "message" ||
			!entry.id ||
			entry.parentId !== saved.branch.parentId ||
			!entry.message ||
			!saved.replies.includes(entry.message)
		)
			continue;
		const reply = entry.message as {
			timestamp?: number;
			provider?: string;
			model?: string;
			stopReason?: string;
			errorMessage?: string;
		};
		if (!reply.provider || !reply.model || typeof reply.timestamp !== "number")
			continue;
		const completion = { finish: reply.stopReason, error: reply.errorMessage };
		if (
			!isSuccessfulProviderCompletion(completion) &&
			!providerResponseFailed(completion)
		)
			continue;
		const response = {
			sessionId,
			request: saved.request,
			responseId: entry.id,
			createdAt: reply.timestamp,
			modelKey: piModelRefToCanonical(`${reply.provider}/${reply.model}`),
			...completion,
			v2: true,
		};
		bindSystemPromptResponse(sessionId, saved.request, response);
		acknowledgeSystemPromptDelivery(response);
		requests.delete(sessionId);
		return;
	}
}

export function clearPiSystemPromptDelivery(sessionId: string): void {
	requests.delete(sessionId);
	clearSystemPromptDelivery(sessionId);
}
