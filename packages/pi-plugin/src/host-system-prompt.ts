/**
 * Reads the host's effective system prompt as one string.
 *
 * Pi's extension API returns a string, while Oh My Pi returns one string per
 * prompt segment (for example its work contract and project context). Callers
 * that measure, hash or search the prompt need the whole text, so segments are
 * joined with a blank line. Returns undefined when the host has no prompt yet
 * or returns an unexpected shape.
 */
export function readHostSystemPrompt(ctx: {
	getSystemPrompt?: () => unknown;
}): string | undefined {
	if (typeof ctx.getSystemPrompt !== "function") return undefined;
	const raw = ctx.getSystemPrompt();
	if (typeof raw === "string") return raw;
	if (Array.isArray(raw) && raw.every((part) => typeof part === "string")) {
		return raw.join("\n\n");
	}
	return undefined;
}
