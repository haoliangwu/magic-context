import { piAgentHistory } from "./pi-dispatch-agent-history";
import {
	type PiChatHistoryModel,
	piChatHistoryPlan,
	piMatchesChatImages,
} from "./pi-dispatch-chat-history";
import { piGoogleConversation } from "./pi-dispatch-google";
import {
	type PiImageBudgetPlan,
	type PiImageRun,
	type PiInputImage,
	piImageBudgetPlan,
	piMatchesImages,
	piRecordImages,
	piRemainingImages,
	piWireImageCount,
	piWireImages,
} from "./pi-dispatch-image-budget";
import {
	piResponsesAssistantTexts,
	piResponsesWireTexts,
} from "./pi-dispatch-responses-history";
import { piToolCallWireId } from "./pi-dispatch-tool-ids";

interface MessageStructure {
	role: "user" | "assistant" | "toolResult";
	calls: string[];
	results: string[];
	wireCalls?: (string | undefined)[];
	wireResults?: (string | undefined)[];
	callNames?: string[];
	resultNames?: string[];
	timestamp?: number;
	exactText?: string;
	exactImages?: readonly string[];
	wireContent?: unknown;
	wireRole?: unknown;
	idlessCalls?: boolean[];
	idlessResults?: boolean[];
	/** JSON [text, phase] pairs for every assistant text block, retained in wire order. */
	responseTexts?: string[];
	images?: readonly PiInputImage[];
}

/** Transport-independent roles and ordered tool IDs, captured before text transforms. */
export interface PiPreparedStructure {
	messages: readonly MessageStructure[];
	chatMessages?: readonly MessageStructure[];
	responsesMessages?: readonly MessageStructure[];
	api?: string;
	googleFunctionIds?: boolean;
	structuralSkipReason?: string;
	imageBudget?: PiImageBudgetPlan<MessageStructure>;
}

const MAX_MESSAGES = 100_000;
const ORPHAN_NOTE = Symbol("prepared orphan tool result");
// These native serializers share transformMessages. Cursor, GitLab and custom
// APIs do not, so their result rows must retain their existing expectations.
const TRANSFORM_MESSAGES_APIS = new Set([
	"openai-completions",
	"openai-responses",
	"openrouter",
	"openai-codex-responses",
	"azure-openai-responses",
	"anthropic-messages",
	"bedrock-converse-stream",
	"google-generative-ai",
	"google-gemini-cli",
	"google-vertex",
	"ollama-chat",
	"factory-droid-agent",
	"devin-agent",
	"apple-foundation-models",
]);

function object(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function messageStructure(value: unknown): MessageStructure | undefined {
	const message = object(value);
	if (!message) return undefined;
	const role = [
		"custom",
		"hookMessage",
		"developer",
		"branchSummary",
		"compactionSummary",
		"bashExecution",
		"pythonExecution",
	].includes(String(message.role))
		? "user"
		: message.role;
	if (role !== "user" && role !== "assistant" && role !== "toolResult")
		return undefined;
	const row: MessageStructure = { role, calls: [], results: [] };
	if (ORPHAN_NOTE in message && typeof message.content === "string") {
		if (message.content.length > 32 * 1024 * 1024) return undefined;
		row.exactText = message.content;
	}
	if (typeof message.timestamp === "number") row.timestamp = message.timestamp;
	if (role === "toolResult") {
		if (typeof message.toolCallId !== "string") return undefined;
		row.results.push(message.toolCallId);
	}
	if (role === "assistant" && Array.isArray(message.content)) {
		for (const value of message.content) {
			const block = object(value);
			if (block?.type !== "toolCall" && block?.type !== "tool_use") continue;
			if (typeof block.id !== "string") return undefined;
			row.calls.push(block.id);
			row.callNames ??= [];
			row.callNames.push(typeof block.name === "string" ? block.name : "");
		}
	}
	return row;
}

function projectMissingToolResults(
	messages: readonly unknown[],
	api?: string,
): unknown[] {
	const projectOrphans = TRANSFORM_MESSAGES_APIS.has(api ?? "");
	const responsesComponents = new Set<string>();
	const opaqueIds = new Set<string>();
	const validToolUseIds = projectOrphans ? new Set<string>() : undefined;
	const component = (id: string) => {
		const pipe = id.indexOf("|");
		return pipe > 0 ? id.slice(0, pipe) : id;
	};
	for (const value of messages) {
		const message = object(value);
		if (message?.role !== "assistant" || !Array.isArray(message.content))
			continue;
		for (const value of message.content) {
			const block = object(value);
			if (block?.type !== "toolCall" || typeof block.id !== "string") continue;
			if (
				[
					"openai-responses",
					"azure-openai-responses",
					"openai-codex-responses",
				].includes(String(message.api))
			) {
				responsesComponents.add(component(block.id));
				validToolUseIds?.add(component(block.id));
			} else {
				if (block.id.includes("|")) opaqueIds.add(block.id);
				validToolUseIds?.add(block.id);
			}
		}
	}
	// Responses item suffixes are not part of the call identity; opaque Chat IDs
	// containing a pipe remain whole (transform-messages.ts:56-59,94-143).
	const pairingId = (id: string) =>
		!opaqueIds.has(id) && responsesComponents.has(component(id))
			? component(id)
			: id;
	const lastResult = new Map<string, number>();
	messages.forEach((value, index) => {
		const message = object(value);
		if (
			message?.role === "toolResult" &&
			typeof message.toolCallId === "string"
		)
			lastResult.set(pairingId(message.toolCallId), index);
	});
	const projected: unknown[] = [];
	const resolved = new Set<string>();
	let pending: { id: string; name: string }[] = [];
	let start = -1;
	let aborted = false;
	let timestamp: unknown;
	const flush = (boundaryTimestamp?: unknown) => {
		for (const call of pending) {
			const key = pairingId(call.id);
			if (resolved.has(key) || (lastResult.get(key) ?? -1) > start) continue;
			projected.push({
				role: "toolResult",
				toolCallId: call.id,
				toolName: call.name,
				content: [
					{ type: "text", text: aborted ? "aborted" : "No result provided" },
				],
				isError: true,
				timestamp: aborted ? timestamp : boundaryTimestamp,
			});
			resolved.add(key);
		}
		pending = [];
	};
	for (let index = 0; index < messages.length; index++) {
		const value = messages[index];
		const message = object(value);
		if (
			(message?.role === "bashExecution" ||
				message?.role === "pythonExecution") &&
			message.excludeFromContext === true
		)
			continue;
		// OMP flushes unresolved calls at every non-result boundary and at EOF,
		// not only on the latest turn. A later real result prevents synthesis;
		// its reordering and all other history rewrites still fail comparison.
		// @oh-my-pi/pi-ai transform-messages.ts:1256-1303,1305-1327,1457-1469 (18.10.4).
		if (message?.role !== "toolResult") flush(message?.timestamp);
		else if (
			typeof message.toolCallId === "string" &&
			pending.some(
				(call) => pairingId(call.id) === pairingId(String(message.toolCallId)),
			)
		)
			resolved.add(pairingId(message.toolCallId));
		else if (
			validToolUseIds &&
			message?.role === "toolResult" &&
			typeof message.toolCallId === "string" &&
			typeof message.toolName === "string" &&
			!validToolUseIds.has(pairingId(message.toolCallId)) &&
			Array.isArray(message.content)
		) {
			// Native replay drops an orphan inside an unresolved normal or aborted
			// result window; otherwise it preserves nonblank text as an unprivileged
			// user note. This changes only the plan, never the returned history.
			// @oh-my-pi/pi-ai transform-messages.ts:1406-1460 (18.11.1).
			if (pending.some((call) => !resolved.has(pairingId(call.id)))) continue;
			const parts = message.content.flatMap((value) => {
				const part = object(value);
				return part?.type === "text" &&
					typeof part.text === "string" &&
					part.text.trim()
					? [part.text]
					: [];
			});
			if (parts.length) {
				const error = message.isError ? ' is-error="true"' : "";
				const note = `<stale-tool-result tool="${message.toolName}" id="${message.toolCallId}"${error}>\n${parts.join("\n")}\n</stale-tool-result>`;
				projected.push({
					role: "user",
					content:
						api === "ollama-chat"
							? note
							: new TextDecoder().decode(new TextEncoder().encode(note)),
					timestamp: message.timestamp,
					[ORPHAN_NOTE]: true,
				});
			}
			continue;
		}
		projected.push(value);
		if (message?.role !== "assistant" || !Array.isArray(message.content))
			continue;
		start = index;
		aborted =
			message.stopReason === "aborted" || message.stopReason === "error";
		timestamp = message.timestamp;
		if (aborted && typeof timestamp !== "number") continue;
		for (const value of message.content) {
			const block = object(value);
			if (block?.type === "toolCall" && typeof block.id === "string")
				pending.push({
					id: block.id,
					name: typeof block.name === "string" ? block.name : "",
				});
		}
	}
	flush();
	return projected;
}

export function piPreparedStructure(
	messages: readonly unknown[],
	model?: PiChatHistoryModel,
): PiPreparedStructure | undefined {
	return buildPiPreparedStructure(messages, model);
}

/** Prepare the returned OMP messages and their dispatch receipt in one walk. */
export function preparePiDispatch<T>(
	messages: T[],
	model: PiChatHistoryModel | undefined,
	omp: boolean,
): { messages: T[]; structure: PiPreparedStructure | undefined } {
	let output = messages;
	const structure = buildPiPreparedStructure(
		messages,
		model,
		omp
			? (index, source) => {
					// OMP replays a user compaction carrier instead of its readable summary.
					// Assistant payloads may be the only copy of encrypted reasoning.
					if (object(source.providerPayload)?.type !== "openaiResponsesHistory")
						return;
					if (output === messages) output = messages.slice();
					const { providerPayload: _payload, ...copy } = source;
					output[index] = copy as T;
				}
			: undefined,
	);
	return { messages: output, structure };
}

function buildPiPreparedStructure(
	messages: readonly unknown[],
	model?: PiChatHistoryModel,
	prepareUser?: (index: number, source: Record<string, unknown>) => void,
): PiPreparedStructure | undefined {
	if (!messages.length || messages.length > MAX_MESSAGES) return undefined;
	for (let index = 0; index < messages.length; index++) {
		const source = object(messages[index]);
		if (source?.role === "user" || source?.role === "compactionSummary")
			prepareUser?.(index, source);
	}
	const projectedMessages = projectMissingToolResults(
		model?.api ? piAgentHistory(messages, model.api) : messages,
		model?.api,
	);
	if (projectedMessages.length > MAX_MESSAGES) return undefined;
	const rows: MessageStructure[] = [];
	const toolNames = new Map<string, string>();
	const toolIds = new Map<string, string | undefined>();
	const responsesToolIds = new Map<string, string | undefined>();
	const byIndex = new Map<number, MessageStructure>();
	const imageBudget = piImageBudgetPlan<MessageStructure>(model);
	let valid = true;
	for (let index = 0; index < projectedMessages.length; index++) {
		const message = projectedMessages[index];
		const source = object(message);
		// History injection and the provider renderer both put instructions before
		// conversation turns. Ignore only that leading system/developer prefix on
		// both sides; a system message inside the conversation remains invalid.
		if (
			rows.length === 0 &&
			(source?.role === "system" || source?.role === "developer")
		)
			continue;
		if (
			(source?.role === "bashExecution" ||
				source?.role === "pythonExecution") &&
			source.excludeFromContext === true
		)
			continue;
		const row = messageStructure(message);
		if (!row) {
			if (!prepareUser) return undefined;
			valid = false;
			continue;
		}
		// These providers omit a user/developer row with no nonblank text or
		// images. In particular, a compaction summary with blocks: [] has no wrapper.
		if (
			[
				"openai-completions",
				"openrouter",
				"anthropic-messages",
				"bedrock-converse-stream",
				"google-generative-ai",
				"google-gemini-cli",
				"google-vertex",
				"openai-responses",
				"azure-openai-responses",
				"openai-codex-responses",
			].includes(model?.api ?? "") &&
			(source?.role === "user" || source?.role === "developer") &&
			(typeof source.content === "string"
				? !source.content.trim()
				: Array.isArray(source.content) &&
					!source.content.some((value) => {
						const block = object(value);
						return (
							block?.type === "image" ||
							(block?.type === "text" &&
								typeof block.text === "string" &&
								block.text.trim())
						);
					}))
		)
			continue;
		row.calls.forEach((id, index) => {
			toolNames.set(id, row.callNames?.[index] ?? "");
			if (model?.api) {
				const normalized = piToolCallWireId(id, model, source);
				row.wireCalls ??= [];
				row.wireCalls.push(normalized);
				toolIds.set(id, normalized);
				if (
					[
						"openai-responses",
						"azure-openai-responses",
						"openai-codex-responses",
					].includes(String(source?.api))
				)
					responsesToolIds.set(id.split("|", 1)[0], normalized);
			}
		});
		if (row.results.length) {
			row.resultNames = row.results.map((id) => toolNames.get(id) ?? "");
			if (model?.api)
				row.wireResults = row.results.map((id) =>
					toolIds.has(id)
						? toolIds.get(id)
						: responsesToolIds.get(id.split("|", 1)[0]),
				);
		}
		rows.push(row);
		byIndex.set(index, row);
		piRecordImages(imageBudget, row, source);
	}
	if (!valid) return undefined;
	const responsesApi = responsesLane(model?.api);
	let responsesMessages: MessageStructure[] | undefined = responsesApi
		? []
		: undefined;
	if (responsesMessages) {
		for (const [index, row] of byIndex) {
			if (row.role !== "assistant") {
				responsesMessages.push(row);
				continue;
			}
			const texts = piResponsesAssistantTexts(projectedMessages[index], model);
			if (!texts) {
				responsesMessages = undefined;
				break;
			}
			if (!texts.length && !row.calls.length) continue;
			// OpenAI Responses encodes assistant text and calls as separate input
			// items. Its normalized role rows combine adjacent assistant messages;
			// mirror that on prepared history without discarding any text or call ID.
			const previous = responsesMessages.at(-1);
			if (previous?.role === "assistant") {
				previous.calls.push(...row.calls);
				previous.wireCalls?.push(...(row.wireCalls ?? []));
				previous.responseTexts?.push(...texts);
			} else
				responsesMessages.push({
					...row,
					calls: [...row.calls],
					...(row.wireCalls ? { wireCalls: [...row.wireCalls] } : {}),
					responseTexts: [...texts],
				});
		}
	}
	const plan = piChatHistoryPlan(projectedMessages, model);
	let pendingToolImages: PiImageRun[] = [];
	const chatMessages = plan?.flatMap((step): MessageStructure[] => {
		if (step.kind === "source") {
			const row = byIndex.get(step.index);
			const images = row && imageBudget?.rows.get(row);
			if (row?.role === "toolResult" && images) pendingToolImages.push(images);
			return row ? [row] : [];
		}
		const row: MessageStructure = {
			role: "user",
			calls: [],
			results: [],
			...(step.kind === "note"
				? { exactText: step.text }
				: { exactImages: step.urls }),
		};
		if (step.kind === "images" && imageBudget && pendingToolImages.length) {
			imageBudget.rows.set(row, {
				first: pendingToolImages[0].first,
				images: pendingToolImages.flatMap((run) => run.images),
				synthesized: true,
			});
			pendingToolImages = [];
		}
		return [row];
	});
	return {
		messages: rows,
		...(imageBudget?.count ? { imageBudget } : {}),
		...(responsesApi && !responsesMessages
			? { structuralSkipReason: "Responses history transform is not modeled" }
			: model?.api === "openai-completions" && !chatMessages
				? { structuralSkipReason: "Chat history transform is not modeled" }
				: {}),
		...(chatMessages ? { chatMessages } : {}),
		...(responsesMessages ? { responsesMessages } : {}),
		...(model?.api ? { api: model.api } : {}),
		...(model?.api?.startsWith("google-")
			? {
					googleFunctionIds:
						object(model.compat)?.supportsFunctionPartId === true,
				}
			: {}),
	};
}

function responsesLane(api: string | undefined): boolean {
	return [
		"openai-responses",
		"azure-openai-responses",
		"openai-codex-responses",
	].includes(api ?? "");
}

function payloadStructure(
	payload: unknown,
	ollama = false,
	responsesItems = false,
	imageProjection = false,
): MessageStructure[] | undefined {
	const body = object(payload);
	if (!body) return undefined;
	const google = piGoogleConversation(payload);
	if (google)
		return googleStructure(google.contents as unknown[], imageProjection);
	const bedrock = body.inferenceConfig !== undefined;
	if (body.messages === undefined && typeof body.input === "string")
		return [{ role: "user", calls: [], results: [] }];
	const responses = body.messages === undefined && Array.isArray(body.input);
	const messages = responses ? body.input : body.messages;
	if (!Array.isArray(messages) || messages.length > MAX_MESSAGES)
		return undefined;
	const rows: MessageStructure[] = [];
	for (const value of messages) {
		const message = object(value);
		if (!message) return undefined;
		// Chat Completions and Azure Responses render context.systemPrompt before
		// context.messages, using system or developer roles. Leading instructions are not
		// prepared turns. piConversationFields keeps the original instruction rows
		// for exact comparison with the first admitted request on later dispatches.
		if (
			rows.length === 0 &&
			(message.role === "system" || message.role === "developer")
		)
			continue;
		// Responses emits reasoning/text/calls as separate items for one assistant
		// turn. Only its call/result IDs survive every supported replay mode.
		if (responses && message.type === "reasoning") continue;
		if (
			responses &&
			["function_call", "custom_tool_call", "computer_call"].includes(
				String(message.type),
			)
		) {
			if (typeof message.call_id !== "string") return undefined;
			let assistant = rows.at(-1);
			if (assistant?.role !== "assistant") {
				assistant = {
					role: "assistant",
					calls: [],
					results: [],
					...(responsesItems ? { responseTexts: [] } : {}),
				};
				rows.push(assistant);
			}
			assistant.calls.push(message.call_id);
			continue;
		}
		if (
			responses &&
			[
				"function_call_output",
				"custom_tool_call_output",
				"computer_call_output",
			].includes(String(message.type))
		) {
			if (typeof message.call_id !== "string") return undefined;
			rows.push({ role: "toolResult", calls: [], results: [message.call_id] });
			if (imageProjection)
				rows[rows.length - 1].images = piWireImages(message.output);
			continue;
		}
		if (message.role === "tool") {
			if (
				message.tool_call_id === undefined &&
				ollama &&
				typeof message.tool_name === "string"
			) {
				// Oh My Pi's Ollama converter emits no pairing IDs, only tool_name.
				// Match the prepared call's name at this exact result position so a
				// reordered or unrelated answer cannot borrow an earlier call's receipt.
				// @oh-my-pi/pi-ai/src/providers/ollama.ts:209-215,229-243 (18.10.4).
				rows.push({
					role: "toolResult",
					calls: [],
					results: [""],
					resultNames: [message.tool_name],
					idlessResults: [true],
					...(imageProjection
						? { images: piWireImages(message.content, message.images) }
						: {}),
				});
				continue;
			}
			if (typeof message.tool_call_id !== "string") return undefined;
			rows.push({
				role: "toolResult",
				calls: [],
				results: [message.tool_call_id],
				...(imageProjection
					? {
							images: piWireImages(
								message.content,
								ollama ? message.images : undefined,
							),
						}
					: {}),
			});
			continue;
		}
		if (message.role === "user" && Array.isArray(message.content)) {
			const results = message.content.filter(
				(block) =>
					object(block)?.type === "tool_result" ||
					(bedrock && object(block)?.toolResult),
			);
			if (results.length) {
				// Anthropic and Bedrock pack a consecutive result run into one user message;
				// expand it back to the prepared array's roles and result IDs.
				for (const block of results) {
					const id = bedrock ? block.toolResult?.toolUseId : block.tool_use_id;
					if (typeof id !== "string") return undefined;
					rows.push({
						role: "toolResult",
						calls: [],
						results: [id],
						...(imageProjection
							? {
									images: piWireImages(
										bedrock ? block.toolResult?.content : block.content,
									),
								}
							: {}),
					});
				}
				if (imageProjection) {
					const images = piWireImages(
						message.content.filter((block) => !results.includes(block)),
					);
					if (images.length)
						rows.push({ role: "user", calls: [], results: [], images });
				}
				continue;
			}
		}
		const row = messageStructure(
			ollama && message.role === "system"
				? { ...message, role: "user" }
				: message,
		);
		if (!row) return undefined;
		row.wireContent = message.content;
		if (imageProjection)
			row.images = piWireImages(
				message.content,
				ollama ? message.images : undefined,
			);
		if (responses && responsesItems && row.role === "assistant") {
			const texts = piResponsesWireTexts(message.content, message.phase);
			if (!texts) return undefined;
			row.responseTexts = [...texts];
		}
		row.wireRole = message.role;
		if (bedrock && row.role === "assistant" && Array.isArray(message.content)) {
			for (const block of message.content) {
				if (!block?.toolUse) continue;
				if (typeof block.toolUse.toolUseId !== "string") return undefined;
				row.calls.push(block.toolUse.toolUseId);
			}
		}
		if (Array.isArray(message.tool_calls)) {
			for (const call of message.tool_calls) {
				const source = object(call);
				if (!source) return undefined;
				if (source.id === undefined && ollama) {
					const fn = object(source.function);
					if (typeof fn?.name !== "string") return undefined;
					row.calls.push("");
					row.callNames ??= [];
					row.callNames.push(fn.name);
					row.idlessCalls ??= [];
					row.idlessCalls.push(true);
				} else {
					if (typeof source.id !== "string") return undefined;
					row.calls.push(source.id);
					if (ollama) {
						row.callNames ??= [];
						row.callNames.push("");
						row.idlessCalls ??= [];
						row.idlessCalls.push(false);
					}
				}
			}
		}
		if (
			responses &&
			row.role === "assistant" &&
			rows.at(-1)?.role === "assistant"
		) {
			const previous = rows[rows.length - 1];
			previous.calls.push(...row.calls);
			if (responsesItems)
				previous.responseTexts?.push(...(row.responseTexts ?? []));
		} else rows.push(row);
	}
	return rows;
}

function googleStructure(
	contents: unknown[],
	imageProjection = false,
): MessageStructure[] | undefined {
	if (contents.length > MAX_MESSAGES) return undefined;
	const rows: MessageStructure[] = [];
	for (const value of contents) {
		const message = object(value);
		if (!message || !Array.isArray(message.parts)) return undefined;
		if (message.role !== "user" && message.role !== "model") return undefined;
		const row: MessageStructure = {
			role: message.role === "model" ? "assistant" : "user",
			calls: [],
			results: [],
			...(imageProjection ? { images: piWireImages(message.parts) } : {}),
			wireRole: message.role,
			wireContent: message.parts,
		};
		const results: MessageStructure[] = [];
		for (const value of message.parts) {
			const part = object(value);
			if (!part) return undefined;
			if (part.functionCall) {
				const call = object(part.functionCall);
				if (
					row.role !== "assistant" ||
					typeof call?.name !== "string" ||
					(call.id !== undefined && typeof call.id !== "string")
				)
					return undefined;
				row.calls.push((call.id as string) ?? "");
				row.callNames ??= [];
				row.callNames.push(call.name);
			}
			if (part.functionResponse) {
				const result = object(part.functionResponse);
				if (
					row.role !== "user" ||
					typeof result?.name !== "string" ||
					(result.id !== undefined && typeof result.id !== "string")
				)
					return undefined;
				results.push({
					role: "toolResult",
					calls: [],
					results: [(result.id as string) ?? ""],
					resultNames: [result.name],
					...(imageProjection ? { images: piWireImages(result.parts) } : {}),
				});
			}
		}
		// Gemini packs adjacent function results into one user content. Its older
		// models omit IDs, but preserve the ordered function names and result run.
		if (results.length) {
			rows.push(...results);
			if (imageProjection && row.images?.length)
				rows.push({ role: "user", calls: [], results: [], images: row.images });
		} else rows.push(row);
	}
	return rows;
}

function wireId(
	id: string,
	anthropic: boolean,
	responses: boolean,
): string | undefined {
	if (anthropic) return id.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
	if (responses) {
		const callId = id.split(/[\n|]/, 1)[0];
		// Long/foreign IDs can be provider-hashed. Without that provider's
		// model/compat state we cannot prove the mapping, so refuse rather than guess.
		return /^[a-zA-Z0-9_-]{1,64}$/.test(callId) ? callId : undefined;
	}
	return id;
}

function matchesUserText(
	content: unknown,
	text: string,
	api: string | undefined,
	responses: boolean,
	googleOrBedrock: boolean,
): boolean {
	if (responses || googleOrBedrock) {
		if (!Array.isArray(content) || content.length !== 1) return false;
		const block = object(content[0]);
		return (
			!!block &&
			block.text === text &&
			(responses
				? block.type === "input_text"
				: Object.keys(block).length === 1)
		);
	}
	if (
		(api === "anthropic-messages" || api === "factory-droid-agent") &&
		Array.isArray(content)
	) {
		const block = content.length === 1 ? object(content[0]) : undefined;
		return block?.type === "text" && block.text === text;
	}
	return content === text;
}

type StructureComparison =
	| "role"
	| "call id"
	| "result id"
	| "name"
	| "count"
	| "timestamp"
	| "content"
	| "exception";

function safeRole(
	row: MessageStructure | undefined,
	readable: boolean,
): string {
	if (!readable) return "unreadable";
	if (!row) return "missing";
	return ["user", "assistant", "toolResult"].includes(row.role)
		? row.role
		: "unknown";
}

function safeCount(value: number | undefined): number | "unreadable" {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
		? value
		: "unreadable";
}

function structureDetail(
	index: number,
	expected: readonly MessageStructure[] | undefined,
	actual: readonly MessageStructure[] | undefined,
	comparison: StructureComparison,
): string {
	const expectedRow = expected?.[index];
	const actualRow = actual?.[index];
	// Only enum roles and numeric counts may leave the comparator. IDs, names,
	// message text and exception messages must never enter refusal diagnostics.
	return `row=${index} expectedRows=${safeCount(expected?.length)} actualRows=${safeCount(actual?.length)} expectedRole=${safeRole(expectedRow, !!expected)} actualRole=${safeRole(actualRow, !!actual)} expectedCalls=${safeCount(expected ? (expectedRow?.calls.length ?? 0) : undefined)} actualCalls=${safeCount(actual ? (actualRow?.calls.length ?? 0) : undefined)} expectedResults=${safeCount(expected ? (expectedRow?.results.length ?? 0) : undefined)} actualResults=${safeCount(actual ? (actualRow?.results.length ?? 0) : undefined)} comparison=${comparison}`;
}

/** Derive only image-dependent rows; all other structural receipts are reused unchanged. */
function trimPreparedImageRows(
	rows: readonly MessageStructure[],
	budget: PiImageBudgetPlan<MessageStructure>,
	drops: number,
): MessageStructure[] {
	const projected: MessageStructure[] = [];
	let hoisted: PiInputImage[] = [];
	const flush = () => {
		if (hoisted.length)
			projected.push({ role: "user", calls: [], results: [], images: hoisted });
		hoisted = [];
	};
	for (const row of rows) {
		if (row.role !== "toolResult") flush();
		const run = budget.rows.get(row);
		if (
			!run ||
			(budget.api === "openai-completions" && row.role === "toolResult")
		) {
			projected.push(row);
			continue;
		}
		const images = piRemainingImages(run, drops);
		if (run.synthesized) {
			if (images.length)
				projected.push({
					...row,
					images,
					exactImages: row.exactImages?.slice(
						run.images.length - images.length,
					),
				});
		} else if (run.hoisted) {
			projected.push(row);
			hoisted.push(...images);
		} else projected.push({ ...row, images });
	}
	flush();
	return projected;
}

/** Return metadata for the first differing zero-based normalized row, or no mismatch. */
export function piPreparedStructureMismatch(
	payload: unknown,
	prepared: PiPreparedStructure | undefined,
	onImageTrim?: (counts: {
		planned: number;
		actual: number;
		trimmed: number;
	}) => void,
): string | undefined {
	// Where the comparison was when something threw, plus the built-in error
	// class. Both are fixed vocabularies, so an exception's message or a
	// getter's value can never reach the refusal text.
	let stage = "image count";
	let row = 0;
	let expectedRows: readonly MessageStructure[] | undefined;
	let rows: readonly MessageStructure[] | undefined;
	try {
		if (prepared?.structuralSkipReason) return undefined;
		const imageBudget = prepared?.imageBudget;
		const actualImages = imageBudget ? piWireImageCount(payload) : 0;
		const trimmed = imageBudget ? imageBudget.count - actualImages : 0;
		if (trimmed < 0) return "comparison=image count";
		// An equal count must take the original structural comparison, including
		// its existing provider text equivalences. Image projection is trim-only.
		const imageProjection = trimmed > 0;
		stage = "wire rows";
		const body = object(payload);
		const ollama =
			prepared?.api === "ollama-chat" &&
			!!body &&
			Array.isArray(body.messages) &&
			body.input === undefined &&
			body.system === undefined &&
			body.inferenceConfig === undefined;
		const responses =
			body?.messages === undefined && Array.isArray(body?.input);
		rows = payloadStructure(
			payload,
			ollama,
			responses && !!prepared?.responsesMessages,
			imageProjection,
		);
		const chat =
			!!body &&
			Array.isArray(body.messages) &&
			(prepared?.api === "openai-completions" || body.system === undefined) &&
			body.input === undefined &&
			body.inferenceConfig === undefined;
		stage = "prepared rows";
		expectedRows =
			responses && prepared?.responsesMessages
				? prepared.responsesMessages
				: chat && prepared?.chatMessages
					? prepared.chatMessages
					: prepared?.messages;
		if (expectedRows && imageProjection && imageBudget)
			expectedRows = trimPreparedImageRows(expectedRows, imageBudget, trimmed);
		if (!rows || !expectedRows)
			return structureDetail(0, expectedRows, rows, "count");
		if (!body) return structureDetail(0, expectedRows, rows, "count");
		stage = "row comparison";
		const google = !!piGoogleConversation(payload);
		const anthropic =
			google ||
			body.inferenceConfig !== undefined ||
			prepared?.api === "anthropic-messages" ||
			(!prepared?.api &&
				body.max_tokens !== undefined &&
				Array.isArray(body.system));
		for (let i = 0; i < Math.min(rows.length, expectedRows.length); i++) {
			row = i;
			const expected = expectedRows[i];
			const actual = rows[i];
			if (actual.role !== expected.role)
				return structureDetail(i, expectedRows, rows, "role");
			if (
				imageProjection &&
				!piMatchesImages(actual.images ?? [], expected.images ?? [])
			)
				return structureDetail(i, expectedRows, rows, "content");
			if (
				expected.responseTexts !== undefined &&
				(expected.responseTexts.length !== actual.responseTexts?.length ||
					expected.responseTexts.some(
						(text, index) => text !== actual.responseTexts?.[index],
					))
			)
				return structureDetail(i, expectedRows, rows, "content");
			if (
				expected.exactText !== undefined ||
				expected.exactImages !== undefined
			) {
				if (actual.wireRole !== "user")
					return structureDetail(i, expectedRows, rows, "role");
				if (
					(expected.exactText !== undefined &&
						!matchesUserText(
							actual.wireContent,
							expected.exactText,
							prepared?.api,
							responses,
							google || body.inferenceConfig !== undefined,
						)) ||
					(expected.exactImages !== undefined &&
						!piMatchesChatImages(actual.wireContent, expected.exactImages))
				)
					return structureDetail(i, expectedRows, rows, "content");
			}
			if (
				actual.calls.length !== expected.calls.length ||
				actual.results.length !== expected.results.length
			)
				return structureDetail(i, expectedRows, rows, "count");
			if (
				actual.timestamp !== undefined &&
				actual.timestamp !== expected.timestamp
			)
				return structureDetail(i, expectedRows, rows, "timestamp");
			for (let j = 0; j < actual.calls.length; j++)
				if (
					(google &&
						actual.calls[j] === "" &&
						prepared?.googleFunctionIds !== true) ||
					(ollama && actual.idlessCalls?.[j] === true)
						? !expected.callNames?.[j] ||
							actual.callNames?.[j] !== expected.callNames[j]
						: (google && prepared?.googleFunctionIds === false) ||
							actual.calls[j] !==
								(expected.wireCalls
									? expected.wireCalls[j]
									: wireId(expected.calls[j], anthropic, responses))
				)
					return structureDetail(
						i,
						expectedRows,
						rows,
						(google && actual.calls[j] === "") ||
							(ollama && actual.idlessCalls?.[j] === true)
							? "name"
							: "call id",
					);
			for (let j = 0; j < actual.results.length; j++)
				if (
					(google &&
						actual.results[j] === "" &&
						prepared?.googleFunctionIds !== true) ||
					(ollama && actual.idlessResults?.[j] === true)
						? !expected.resultNames?.[j] ||
							actual.resultNames?.[j] !== expected.resultNames[j]
						: (google && prepared?.googleFunctionIds === false) ||
							actual.results[j] !==
								(expected.wireResults
									? expected.wireResults[j]
									: wireId(expected.results[j], anthropic, responses))
				)
					return structureDetail(
						i,
						expectedRows,
						rows,
						(google && actual.results[j] === "") ||
							(ollama && actual.idlessResults?.[j] === true)
							? "name"
							: "result id",
					);
		}
		if (rows.length !== expectedRows.length)
			return structureDetail(
				Math.min(rows.length, expectedRows.length),
				expectedRows,
				rows,
				"count",
			);
		if (imageProjection && imageBudget)
			onImageTrim?.({
				planned: imageBudget.count,
				actual: actualImages,
				trimmed,
			});
		return undefined;
	} catch (error) {
		// Unreadable payloads still fail closed; report where, not what was read.
		const name =
			error instanceof Error &&
			[
				"Error",
				"TypeError",
				"RangeError",
				"SyntaxError",
				"ReferenceError",
			].includes(error.constructor.name)
				? error.constructor.name
				: "unknown";
		return `${structureDetail(row, expectedRows, rows, "exception")} stage=${stage} error=${name}`;
	}
}

/** Check the latest turn as well as every preceding role and ordered tool ID. */
export function piMatchesPreparedStructure(
	payload: unknown,
	prepared: PiPreparedStructure | undefined,
): boolean {
	return piPreparedStructureMismatch(payload, prepared) === undefined;
}
