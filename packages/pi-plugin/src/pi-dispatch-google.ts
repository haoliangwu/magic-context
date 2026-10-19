/** Native Gemini/Vertex plans and Cloud Code Assist's request envelope. */
export function piGoogleConversation(
	payload: unknown,
): Record<string, unknown> | undefined {
	if (!payload || typeof payload !== "object") return undefined;
	const body = payload as Record<string, unknown>;
	if (body.messages !== undefined || body.input !== undefined) return undefined;
	if (Array.isArray(body.contents)) return body;
	const request = body.request;
	if (!request || typeof request !== "object") return undefined;
	const conversation = request as Record<string, unknown>;
	return Array.isArray(conversation.contents) ? conversation : undefined;
}
