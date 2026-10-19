import type { ContextEvent } from "@earendil-works/pi-coding-agent";

// OMP marks an ephemeral request with a developer reminder and a final user
// prompt, both attributed to "agent" in the context event. Provider adapters
// erase attribution; reminder text on the wire is not proof of a side request.
const SIDE_REMINDER =
	"<system-reminder>\nEphemeral side-channel turn; reuses current conversation context.\nTool catalog attached only to keep prompt cache warm; tools NOT available this turn.\nDo NOT emit tool calls; reply plain text only. Tool calls discarded without execution.\n</system-reminder>";

function textContainsReminder(value: unknown): boolean {
	if (typeof value === "string") return value.trim() === SIDE_REMINDER;
	if (!Array.isArray(value)) return false;
	return value.some((block) => {
		if (!block || typeof block !== "object") return false;
		const part = block as { text?: unknown; content?: unknown };
		return typeof part.text === "string" && part.text.trim() === SIDE_REMINDER;
	});
}

export function isOmpSideContext(event: ContextEvent): boolean {
	const tail = event.messages.at(-1) as
		| { role?: unknown; attribution?: unknown }
		| undefined;
	if (tail?.role !== "user" || tail.attribution !== "agent") return false;
	return event.messages.some((message) => {
		const row = message as {
			role?: unknown;
			attribution?: unknown;
			content?: unknown;
		};
		return (
			row.role === "developer" &&
			row.attribution === "agent" &&
			textContainsReminder(row.content)
		);
	});
}

const ADVISOR_PREFIX =
	"<conventions>\nRFC 2119 keywords: MUST, REQUIRED, SHOULD, RECOMMENDED, MAY, OPTIONAL. `NEVER`=`MUST NOT`; `AVOID`=`SHOULD NOT`.\n</conventions>\n\nUser, code-quality, robustness advocate; peer-shadow main agent.\n";
const ADVISOR_WORKFLOW =
	"<workflow>\nReceive incremental agent transcript, including thoughts.\n";
const CAPTURE_PREFIX =
	"Automated capture turn — not a user reply; user has not responded to your previous turn.";

function record(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function firstText(
	value: unknown,
	type: "text" | "input_text",
): string | undefined {
	if (typeof value === "string") return value;
	if (!Array.isArray(value)) return undefined;
	const part = record(value[0]);
	return part?.type === type && typeof part.text === "string"
		? part.text
		: undefined;
}

// Only consume the leading instruction run emitted by a provider adapter. A
// quoted prompt in user content, or instructions later in history, cannot turn
// an ordinary conversation into an advisor request.
function leadingInstructions(
	messages: unknown[],
	roles: readonly string[],
	inputBlocks = false,
) {
	const system: string[] = [];
	let index = 0;
	while (index < messages.length) {
		const message = record(messages[index]);
		if (typeof message?.role !== "string" || !roles.includes(message.role))
			break;
		const content = message.content;
		if (typeof content === "string") system.push(content);
		else if (
			inputBlocks &&
			message.type === "message" &&
			Array.isArray(content) &&
			content.length > 0 &&
			content.every(
				(part) =>
					record(part)?.type === "input_text" &&
					typeof record(part)?.text === "string",
			)
		) {
			// OpenAI Codex wraps extra developer prompts as type:"message" with
			// input_text blocks, unlike the other adapters' string content.
			system.push(content.map((part) => record(part)?.text).join("\n"));
		} else return undefined;
		index++;
	}
	return { system, messages: messages.slice(index) };
}

// OMP uses different envelopes for Messages, chat-completions and Responses.
// Keep their instruction locations and tool encodings separate: accepting a
// hybrid envelope would let unrelated fields establish an advisor exemption.
function providerRequest(payload: unknown) {
	const body = record(payload);
	if (!body || !Array.isArray(body.tools)) return undefined;
	if (Array.isArray(body.input)) {
		if (
			"messages" in body ||
			"system" in body ||
			(body.instructions !== undefined && typeof body.instructions !== "string")
		)
			return undefined;
		// Responses puts the advisor prompt in instructions or leading input
		// system/developer messages. Codex may also prepend extra developer
		// prompts to input, but instructions still owns the advisor identity.
		const leading = leadingInstructions(
			body.input,
			typeof body.instructions === "string"
				? ["developer"]
				: ["system", "developer"],
			typeof body.instructions === "string",
		);
		if (!leading) return undefined;
		return {
			messages: leading.messages,
			system:
				typeof body.instructions === "string"
					? [body.instructions]
					: leading.system.slice(0, 1),
			tools: body.tools.map((tool) => {
				const entry = record(tool);
				return entry?.type === "function" && !("function" in entry)
					? entry.name
					: undefined;
			}),
			textType: "input_text" as const,
		};
	}
	if (
		!Array.isArray(body.messages) ||
		"input" in body ||
		"instructions" in body
	)
		return undefined;
	if (!("system" in body)) {
		const leading = leadingInstructions(body.messages, ["system", "developer"]);
		if (!leading?.system.length) return undefined;
		return {
			...leading,
			system: leading.system.slice(0, 1),
			tools: body.tools.map((tool) => {
				const entry = record(tool);
				return entry?.type === "function" && !("name" in entry)
					? record(entry.function)?.name
					: undefined;
			}),
			textType: "text" as const,
		};
	}
	const system =
		typeof body.system === "string"
			? [body.system]
			: Array.isArray(body.system)
				? body.system.map(firstTextBlock)
				: [];
	const tools = body.tools.map((tool) => {
		const entry = record(tool);
		const name =
			entry && !("function" in entry) && entry.type !== "function"
				? entry.name
				: undefined;
		// Anthropic's OAuth login and escapeBuiltinToolNames option send
		// "_advise" instead of "advise". Undo that single provider prefix;
		// ordinary API-key requests can already have the unprefixed name.
		return typeof name === "string"
			? name.startsWith("_")
				? name.slice(1)
				: name
			: undefined;
	});
	return { messages: body.messages, system, tools, textType: "text" as const };
}

function firstTextBlock(value: unknown): string | undefined {
	const part = record(value);
	return part?.type === "text" && typeof part.text === "string"
		? part.text
		: undefined;
}

/** OMP's advisor reviews formatted copies of new conversation messages in its own agent history. */
export function isOmpAdvisorRequest(payload: unknown): boolean {
	const request = providerRequest(payload);
	if (!request?.tools.includes("advise")) return false;
	if (
		!request.system.some(
			(text) =>
				text?.startsWith(ADVISOR_PREFIX) && text.includes(ADVISOR_WORKFLOW),
		)
	)
		return false;
	const first = record(request.messages[0]);
	if (first?.role !== "user") return false;
	let text = firstText(first.content, request.textType)?.replace(
		/^<system-reminder>\nToday: [^\n]+\n<\/system-reminder>(?:\n|$)/,
		"",
	);
	// OpenAI adapters separate the date and working-directory reminder from
	// the review text. If the first block is only that reminder, read the next.
	if (text === "" && Array.isArray(first.content))
		text = firstText(first.content.slice(1, 2), request.textType);
	return text?.startsWith("### Session update\n\n") === true;
}

/** OMP auto-learn copies raw conversation messages, skipping Magic Context's tagging/pruning; a main-pass receipt cannot authorize that copy. */
export function isOmpUnmanagedCaptureRequest(payload: unknown): boolean {
	const request = providerRequest(payload);
	if (
		!request?.tools.length ||
		!request.tools.every((name) => name === "manage_skill" || name === "learn")
	)
		return false;
	const last = record(request.messages.at(-1));
	return (
		last?.role === "user" &&
		firstText(last.content, request.textType)?.startsWith(CAPTURE_PREFIX) ===
			true
	);
}
