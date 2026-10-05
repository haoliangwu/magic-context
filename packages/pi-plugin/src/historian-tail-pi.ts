import {
	getLastCompartmentEndMessage,
	getLastCompartmentEndMessageId,
} from "@magic-context/core/features/magic-context/compartment-storage";
import type { RawMessage } from "@magic-context/core/hooks/magic-context/read-session-raw";
import type { Database } from "@magic-context/core/shared/sqlite";

/** Resolve a bounded raw tail only when the durable anchor proves its absolute coordinates. */
export function readPiHistorianTail(
	db: Database,
	sessionId: string,
	provider: {
		readMessages: () => RawMessage[];
		readMessagePage?: (
			after: number,
			limit: number,
			watermark: number,
		) => RawMessage[];
		getMessageCount?: () => number;
	},
) {
	const end = getLastCompartmentEndMessage(db, sessionId);
	const anchor = getLastCompartmentEndMessageId(db, sessionId);
	if (
		end > 0 &&
		anchor &&
		provider.readMessagePage &&
		provider.getMessageCount
	) {
		const absoluteMessageCount = provider.getMessageCount();
		const messages = provider.readMessagePage(
			end - 1,
			Number.MAX_SAFE_INTEGER,
			absoluteMessageCount,
		);
		if (messages[0]?.ordinal === end && messages[0]?.id === anchor)
			return { messages, absoluteMessageCount };
	}
	const messages = provider.readMessages();
	return { messages, absoluteMessageCount: messages.length };
}
