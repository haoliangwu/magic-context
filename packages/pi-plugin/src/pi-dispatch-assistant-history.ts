/**
 * Oh My Pi does not replay interrupted assistants with no text or tool call.
 * Test block presence, not text content: even an empty text block keeps a turn.
 * Call only where the host's transformMessages is known to run; plain Pi has
 * different replay rules.
 * @oh-my-pi/pi-ai src/providers/transform-messages.ts, predicate / replay drop:
 * 18.8.9:361/1197, 18.11.3:462/1369, 18.12.3:483/1398. Same semantics in all
 * three; the predicate became exported after 18.8.9.
 */
export function piOmitsTruncatedAssistant(
	message: Record<string, unknown>,
): boolean {
	return (
		(message.stopReason === "length" ||
			message.stopReason === "error" ||
			message.stopReason === "aborted") &&
		Array.isArray(message.content) &&
		!message.content.some(
			(block) => block?.type === "text" || block?.type === "toolCall",
		)
	);
}
