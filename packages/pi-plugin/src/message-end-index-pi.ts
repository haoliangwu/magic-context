import { scheduleIncrementalIndex } from "@magic-context/core/features/magic-context/message-index-async";
import type { Database } from "@magic-context/core/shared/sqlite";
import { convertPiAssistantEntryById } from "./read-session-pi";

export interface PiMessageEndIndexDeps {
	schedule?: typeof scheduleIncrementalIndex;
}

/** Scheduling keys for ended messages Pi has not yet stored as entries. */
let unpersistedMessageSeq = 0;

/** The session entry that stores this exact message object, if Pi has stored it yet. */
function findEntryIdForMessage(
	branch: readonly unknown[] | undefined,
	message: object,
): string | undefined {
	if (!Array.isArray(branch)) return undefined;
	for (let index = branch.length - 1; index >= 0; index--) {
		const entry = branch[index] as {
			type?: unknown;
			id?: unknown;
			message?: unknown;
		} | null;
		if (
			entry?.type === "message" &&
			entry.message === message &&
			typeof entry.id === "string" &&
			entry.id.length > 0
		) {
			return entry.id;
		}
	}
	return undefined;
}

/**
 * Queue the assistant message that just ended for the message search index.
 *
 * Raw messages are keyed by their session entry id, but a Pi AssistantMessage
 * carries no id, and Pi stores the message as an entry (assigning that id)
 * only after extension message_end handlers return. So the entry is looked up
 * by object identity when the index work runs, after its debounce, by which
 * time Pi has stored it. If the entry already exists now (a host that stores
 * first), its id is used directly.
 */
export function schedulePiAssistantIndexOnMessageEnd(
	db: Database,
	sessionId: string,
	endedMessage: unknown,
	session: {
		readBranch: () => readonly unknown[] | undefined;
	},
	deps: PiMessageEndIndexDeps = {},
): void {
	if (endedMessage === null || typeof endedMessage !== "object") return;
	if ((endedMessage as { role?: unknown }).role !== "assistant") return;
	const storedId = findEntryIdForMessage(session.readBranch(), endedMessage);
	const schedulingId =
		storedId ?? `pi-message-end-pending:${++unpersistedMessageSeq}`;
	(deps.schedule ?? scheduleIncrementalIndex)(
		db,
		sessionId,
		schedulingId,
		() => {
			const branch = session.readBranch();
			const entryId = storedId ?? findEntryIdForMessage(branch, endedMessage);
			if (!entryId || !branch) return null;
			return convertPiAssistantEntryById(branch, entryId);
		},
	);
}
