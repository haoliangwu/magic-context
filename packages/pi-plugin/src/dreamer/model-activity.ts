import { isRecord } from "@magic-context/core/shared/record-type-guard";

/** Startup and assistant messages without text, reasoning, tool calls or usage are not model output. */
export function piEventShowsModelOutput(event: unknown): boolean {
	if (!isRecord(event)) return false;
	if (event.type !== "message_update" && event.type !== "message_end")
		return false;
	// OMP's JSON print mode omits message snapshots from streaming updates.
	const update = event.assistantMessageEvent;
	if (event.type === "message_update" && isRecord(update)) {
		if (update.type === "toolcall_start") return true;
		if (
			["text_delta", "thinking_delta", "toolcall_delta"].includes(
				String(update.type),
			) &&
			typeof update.delta === "string" &&
			update.delta.length > 0
		)
			return true;
	}
	const message = event.message;
	if (!isRecord(message) || message.role !== "assistant") return false;
	if (
		Array.isArray(message.content) &&
		message.content.some(
			(part) =>
				isRecord(part) &&
				(part.type === "toolCall" ||
					(part.type === "text" &&
						typeof part.text === "string" &&
						part.text.length > 0) ||
					(part.type === "thinking" &&
						typeof part.thinking === "string" &&
						part.thinking.length > 0)),
		)
	)
		return true;
	const usage = message.usage;
	return (
		isRecord(usage) &&
		["input", "output", "cacheRead", "cacheWrite"].some(
			(key) => typeof usage[key] === "number" && usage[key] > 0,
		)
	);
}
