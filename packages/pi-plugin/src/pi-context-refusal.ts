import type {
	ContextEvent,
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { isCheckoutClaimRefusalError } from "@magic-context/core/features/magic-context/checkout-claim";
import { log } from "@magic-context/core/shared/logger";
import { withSqliteTransformPass } from "@magic-context/core/shared/sqlite";

const ENTRY_TYPE = "magic-context-turn-refused";
const RETRY_MESSAGE =
	"Magic Context could not safely prepare this turn; send your message again.";

/**
 * Pi catches context-hook exceptions and continues with its original messages.
 * Escaping errors here are deliberate refusals: abort the operation as well as
 * logging the original error. The entry is display-only, never a model message.
 */
export function registerPiGuardedContext(
	pi: ExtensionAPI,
	handler: (
		event: ContextEvent,
		ctx: ExtensionContext,
	) =>
		| Promise<{ messages: ContextEvent["messages"] } | undefined>
		| Promise<void>,
): void {
	pi.registerEntryRenderer?.<{ message: string }>(
		ENTRY_TYPE,
		(entry) => new Text(entry.data?.message ?? RETRY_MESSAGE, 0, 0),
	);
	pi.on("context", async (event, ctx) => {
		try {
			// Share at most 250 ms of synchronous writer waiting across the turn,
			// including autocommit statements, as in OpenCode.
			// Do not rerun the handler: it may already have committed earlier writes.
			return await withSqliteTransformPass(() => handler(event, ctx));
		} catch (error) {
			log("[magic-context][pi] turn refused", error);
			// A checkout-claim refusal is not a retryable preparation failure: the
			// user has to move the agent first, so show its own message instead.
			const message = isCheckoutClaimRefusalError(error)
				? error.message
				: RETRY_MESSAGE;
			// Direct handler fixtures lack the host abort API; retain their original
			// exception contract. Real Pi contexts always supply abort().
			if (typeof ctx.abort !== "function") throw error;
			if (message !== RETRY_MESSAGE && ctx.hasUI) {
				try {
					ctx.ui.notify(message, "error");
				} catch (notifyError) {
					log("[magic-context][pi] refusal notice failed", notifyError);
				}
			}
			try {
				pi.appendEntry(ENTRY_TYPE, { message });
			} catch (displayError) {
				log("[magic-context][pi] refusal entry failed", displayError);
			} finally {
				// This is abort-in-flight, not a pre-dispatch veto: Pi may still build
				// the provider request, but its operation signal is already aborted.
				ctx.abort();
			}
			return { messages: event.messages };
		}
	});
}
