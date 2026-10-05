/** Provider instructions and tool deltas are protocol state, never reclaimable content. */
export interface PiSystemEntry {
	role: "system";
	content: string | { type: "text"; text: string; textSignature?: string }[];
	sections?: Record<string, string | null>;
	toolsAdded?: readonly unknown[];
	toolsRemoved?: readonly { name: string }[];
	timestamp?: number;
}

export interface PiEffectiveSystemState {
	prompt: string;
	tools: readonly { name: string; identity: string }[];
}

export type PiCompactionSnapshotAdoption =
	| { kind: "adopted" }
	| {
			kind: "divergent";
			foldingOnlyTools: string[];
			persistedOnlyTools: string[];
			changedTools: string[];
			foldingPromptLength: number;
			persistedPromptLength: number;
	  }
	| { kind: "unavailable"; reason: string };

/** Role alone is the compatibility boundary; older Pi and OMP transcripts have none. */
export function isPiSystemEntry(message: unknown): message is PiSystemEntry {
	return (
		message !== null &&
		typeof message === "object" &&
		"role" in message &&
		message.role === "system"
	);
}

/** Insert history users after the leading system run: Pi reads initial tool declarations only at index zero. */
export function piPrefixInsertionIndex(messages: readonly unknown[]): number {
	let index = 0;
	while (isPiSystemEntry(messages[index])) index++;
	return index;
}

/**
 * Place Pi's initial tool declaration where its transports can see it and return
 * the insertion point for Magic Context's two synthetic history messages.
 *
 * Pi 0.86 `dist/utils/transcript.js:31-35` only examines `messages[0]` for the
 * initial system message, and lines 195-200 use that message's tools for
 * addition-capable transports. Its tool and prompt folds skip non-system messages
 * (lines 43-45 and 62-64), but lines 101-103 preserve array order for transports
 * that accept mid-conversation systems. Promoting the system therefore changes
 * its order relative to displaced users; the index-zero initial-tools contract
 * takes priority, while those users keep their relative order before MC history.
 */
export function placePiInitialSystemAtHead(messages: unknown[]): number {
	let firstSystemIndex = -1;
	let firstSystemWithToolsIndex = -1;
	for (let index = 0; index < messages.length; index++) {
		const message = messages[index];
		if (!isPiSystemEntry(message)) continue;
		if (firstSystemIndex < 0) firstSystemIndex = index;
		if (
			firstSystemWithToolsIndex < 0 &&
			Array.isArray(message.toolsAdded) &&
			message.toolsAdded.length > 0
		) {
			firstSystemWithToolsIndex = index;
		}
	}
	const selectedIndex =
		firstSystemWithToolsIndex >= 0
			? firstSystemWithToolsIndex
			: firstSystemIndex;
	if (selectedIndex <= 0) return piPrefixInsertionIndex(messages);
	const [initialSystem] = messages.splice(selectedIndex, 1);
	messages.unshift(initialSystem);
	// Every entry that preceded the selected system keeps its relative order and
	// remains before the two synthetic history messages; only the selected system
	// is moved to index zero.
	return selectedIndex + 1;
}

export function isPiSystemMessageEntry(entry: unknown): boolean {
	return (
		entry !== null &&
		typeof entry === "object" &&
		"message" in entry &&
		isPiSystemEntry(entry.message)
	);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object";
}

function piContentText(content: PiSystemEntry["content"]): string {
	if (typeof content === "string") return content;
	return content
		.filter((block) => block.type === "text")
		.map((block) => block.text)
		.join("\n");
}

export function piToolIdentity(tool: unknown): {
	name: string;
	identity: string;
} {
	if (!isRecord(tool) || typeof tool.name !== "string") {
		throw new Error("Pi system tool declaration has no string name");
	}
	const declaration = {
		name: tool.name,
		description: tool.description,
		parameters: JSON.parse(JSON.stringify(tool.parameters)),
		...(tool.constrainedSampling === undefined
			? {}
			: { constrainedSampling: tool.constrainedSampling }),
	};
	return { name: tool.name, identity: JSON.stringify(declaration) };
}

/**
 * Resolve the same effective tool declarations and prompt text as Pi 0.86.
 *
 * This is a local mirror because the runtime plugin must still load on Pi 0.85,
 * whose pi-ai package does not export these resolvers. The test "mirrors installed
 * Pi 0.86 system resolvers across protocol fixtures" differentially pins this
 * implementation to the installed getCurrentTools/getCurrentSystemPrompt behavior.
 */
export function resolvePiEffectiveSystemState(
	messages: readonly unknown[],
): PiEffectiveSystemState {
	const content: string[] = [];
	const sections = new Map<string, string>();
	const tools = new Map<string, unknown>();
	for (const message of messages) {
		if (!isPiSystemEntry(message)) continue;
		const text = piContentText(message.content);
		if (text.length > 0) content.push(text);
		for (const [name, value] of Object.entries(message.sections ?? {})) {
			if (value === null) sections.delete(name);
			else sections.set(name, value);
		}
		for (const removed of message.toolsRemoved ?? [])
			tools.delete(removed.name);
		for (const added of message.toolsAdded ?? []) {
			const identity = piToolIdentity(added);
			tools.set(identity.name, added);
		}
	}
	const prompt = [content.join("\n\n"), ...sections.values()]
		.filter((part) => part.length > 0)
		.join("\n\n");
	return {
		prompt,
		tools: [...tools.values()]
			.map(piToolIdentity)
			.sort((left, right) =>
				left.name === right.name
					? left.identity.localeCompare(right.identity)
					: left.name.localeCompare(right.name),
			),
	};
}

function findCompactionEntryIndex(
	entries: readonly unknown[],
	compactionId: string,
): number {
	return entries.findIndex(
		(entry) =>
			isRecord(entry) &&
			entry.type === "compaction" &&
			entry.id === compactionId,
	);
}

/**
 * Adopt a persisted host snapshot only when it represents the same effective
 * system state that Magic Context folded at pass start.
 */
export function adoptPiCompactionSystemSnapshot(
	messages: unknown[],
	entries: readonly unknown[],
	compactionId: string,
	foldingState: PiEffectiveSystemState,
	syntheticHistoryMessages: readonly unknown[] = [],
): PiCompactionSnapshotAdoption {
	try {
		const compactionIndex = findCompactionEntryIndex(entries, compactionId);
		if (compactionIndex < 0) {
			return {
				kind: "unavailable",
				reason: "persisted compaction entry missing",
			};
		}
		const entry = entries[compactionIndex];
		if (!isRecord(entry)) {
			return { kind: "unavailable", reason: "persisted compaction is invalid" };
		}
		const systemMessage =
			"systemMessage" in entry && isPiSystemEntry(entry.systemMessage)
				? entry.systemMessage
				: null;
		// Pi 0.87+ withholds system messages from `context` handlers and restores
		// the prompt and tools itself after they run (runner.js emitContext). A
		// folding input with no system message at all therefore never exposed
		// system state that Magic Context could have changed, and the host's
		// checkpoint is its own journal state. Adopt it without inserting system
		// messages the host would restore a second time. Older transcripts with no
		// system entries reach the same result through the equality check below.
		if (systemMessage && !messages.some(isPiSystemEntry)) {
			return { kind: "adopted" };
		}
		const postBoundaryDeltas = entries
			.slice(compactionIndex + 1)
			.filter(isPiSystemMessageEntry)
			.map((postEntry) => (postEntry as { message: PiSystemEntry }).message);
		const persistedMessages = systemMessage
			? [systemMessage, ...postBoundaryDeltas]
			: postBoundaryDeltas;
		const persistedState = resolvePiEffectiveSystemState(persistedMessages);
		const foldingTools = new Map(
			foldingState.tools.map((tool) => [tool.name, tool.identity]),
		);
		const persistedTools = new Map(
			persistedState.tools.map((tool) => [tool.name, tool.identity]),
		);
		const foldingOnlyTools = [...foldingTools.keys()].filter(
			(name) => !persistedTools.has(name),
		);
		const persistedOnlyTools = [...persistedTools.keys()].filter(
			(name) => !foldingTools.has(name),
		);
		const changedTools = [...foldingTools.keys()].filter(
			(name) =>
				persistedTools.has(name) &&
				persistedTools.get(name) !== foldingTools.get(name),
		);
		if (
			foldingOnlyTools.length > 0 ||
			persistedOnlyTools.length > 0 ||
			changedTools.length > 0 ||
			persistedState.prompt !== foldingState.prompt
		) {
			return {
				kind: "divergent",
				foldingOnlyTools,
				persistedOnlyTools,
				changedTools,
				foldingPromptLength: new TextEncoder().encode(foldingState.prompt)
					.byteLength,
				persistedPromptLength: new TextEncoder().encode(persistedState.prompt)
					.byteLength,
			};
		}

		// Older Pi entries legitimately omit systemMessage when the effective prompt
		// and tool set are empty; equality is sufficient and no adoption is needed.
		if (!systemMessage) return { kind: "adopted" };
		const snapshot = structuredClone(systemMessage);
		const deltas = structuredClone(postBoundaryDeltas);
		const content = messages.filter((message) => !isPiSystemEntry(message));
		messages.splice(0, messages.length, snapshot, ...content, ...deltas);
		if (typeof snapshot.timestamp === "number") {
			for (let offset = 0; offset < syntheticHistoryMessages.length; offset++) {
				const message = syntheticHistoryMessages[offset];
				if (!isRecord(message) || !("timestamp" in message)) continue;
				message.timestamp = snapshot.timestamp + offset - 2;
			}
		}
		return { kind: "adopted" };
	} catch (error) {
		return {
			kind: "unavailable",
			reason: error instanceof Error ? error.message : String(error),
		};
	}
}
