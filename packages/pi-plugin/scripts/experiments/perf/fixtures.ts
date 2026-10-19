import { readFileSync, statSync } from "node:fs";
import { basename, resolve } from "node:path";
import {
	buildSessionContext,
	parseSessionEntries,
	type SessionEntry,
	type SessionHeader,
} from "@earendil-works/pi-coding-agent";

export interface PerfFixture {
	name: string;
	sessionId: string;
	cwd: string;
	entries: SessionEntry[];
	sourceBytes: number;
}

export interface PerfPassInput {
	requestedMessages: number;
	messages: unknown[];
	branchEntries: SessionEntry[];
}

interface SyntheticOptions {
	messages: number;
	/**
	 * Start the branch with a persisted system message entry, as Pi 0.87 does.
	 * The entry is not counted in `messages`.
	 */
	systemEntry?: boolean;
	/** Times each tool result repeats its "result line " filler text (default 12-16). */
	toolResultRepeat?: number;
	/**
	 * Message entries before a Magic Context-owned compaction entry. They stay
	 * on the branch but Pi no longer sends them, as in a long folded session.
	 * They are added to `messages`; the compaction keeps the next 600 entries.
	 */
	hiddenMessages?: number;
}

export function loadFixture(path: string): PerfFixture {
	const absolutePath = resolve(path);
	const parsed = parseSessionEntries(readFileSync(absolutePath, "utf8"));
	const header = parsed.find(
		(entry): entry is SessionHeader => entry.type === "session",
	);
	if (!header)
		throw new Error(`Pi fixture has no session header: ${absolutePath}`);
	const entries = parsed.filter(
		(entry): entry is SessionEntry => entry.type !== "session",
	);
	if (entries.length === 0)
		throw new Error(`Pi fixture has no session entries: ${absolutePath}`);
	return {
		name: basename(absolutePath),
		sessionId: header.id,
		cwd: header.cwd,
		entries,
		sourceBytes: statSync(absolutePath).size,
	};
}

export function generateSyntheticFixture(
	options: SyntheticOptions,
): PerfFixture {
	const sessionId = "mc-pi-perf-synthetic";
	const entries: SessionEntry[] = [];
	let parentId: string | null = null;
	let timestamp = 1_750_000_000_000;
	let sequence = 0;

	const append = (message: Record<string, unknown>): void => {
		const id = `synthetic-entry-${String(sequence).padStart(6, "0")}`;
		entries.push({
			type: "message",
			id,
			parentId,
			timestamp: new Date(timestamp).toISOString(),
			message,
		} as unknown as SessionEntry);
		parentId = id;
		timestamp += 1_000;
		sequence += 1;
	};

	if (options.systemEntry) {
		entries.push({
			type: "message",
			id: "synthetic-system-entry",
			parentId,
			timestamp: new Date(timestamp).toISOString(),
			message: {
				role: "system",
				content: "You are a synthetic coding agent.",
				toolsAdded: [
					{
						name: "read",
						description: "Read a file",
						parameters: { type: "object", properties: {} },
					},
				],
				timestamp,
			},
		} as unknown as SessionEntry);
		parentId = "synthetic-system-entry";
		timestamp += 1_000;
	}
	const hiddenMessages = options.hiddenMessages ?? 0;
	const messageLimit = options.messages + hiddenMessages;
	while (sequence < messageLimit) {
		const turn = Math.floor(sequence / 6);
		append({
			role: "user",
			content:
				turn % 7 === 0
					? [
							{
								type: "text",
								text: `Inspect turn ${turn} and keep the exact wire shape.`,
							},
							{
								type: "image",
								data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB",
								mimeType: "image/png",
							},
						]
					: `Inspect turn ${turn} and summarize the relevant implementation details.`,
			timestamp,
		});
		if (sequence >= messageLimit) break;

		// Reuse call IDs across turns to verify that owner message IDs prevent
		// distinct tool calls from merging when stable parts reuse persisted tags.
		const callId = `call-${turn % 11}`;
		append({
			role: "assistant",
			content: [
				{ type: "thinking", thinking: `Reasoning for synthetic turn ${turn}.` },
				{ type: "text", text: `I will inspect the files for turn ${turn}.` },
				{
					type: "toolCall",
					id: callId,
					name: turn % 2 === 0 ? "read" : "bash",
					arguments: {
						filePath: `/tmp/project/file-${turn % 17}.ts`,
						offset: turn,
					},
				},
			],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			usage: emptyUsage(),
			stopReason: "toolUse",
			timestamp,
		});
		if (sequence >= messageLimit) break;

		append({
			role: "toolResult",
			toolCallId: callId,
			toolName: turn % 2 === 0 ? "read" : "bash",
			content: [
				{
					type: "text",
					text: `Tool output ${turn}: ${"result line ".repeat((options.toolResultRepeat ?? 12) + (turn % 5))}`,
				},
			],
			details: { truncated: false },
			isError: false,
			timestamp,
		});
		if (sequence >= messageLimit) break;

		append({
			role: "assistant",
			content: [
				{ type: "text", text: `The result for turn ${turn} is ready.` },
			],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			usage: emptyUsage(),
			stopReason: "stop",
			timestamp,
		});
		if (sequence >= messageLimit) break;

		append({
			role: "user",
			content: [{ type: "text", text: `Continue with follow-up ${turn}.` }],
			timestamp,
		});
		if (sequence >= messageLimit) break;

		append({
			role: "assistant",
			content: [
				{ type: "thinking", thinking: `Short follow-up reasoning ${turn}.` },
				{ type: "text", text: `Follow-up ${turn} complete.` },
			],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			usage: emptyUsage(),
			stopReason: "stop",
			timestamp,
		});
	}

	if (hiddenMessages > 0) insertMagicContextCompaction(entries, hiddenMessages);

	return {
		name: `synthetic-${options.messages}`,
		sessionId,
		cwd: process.cwd(),
		entries,
		sourceBytes: Buffer.byteLength(JSON.stringify(entries), "utf8"),
	};
}

/**
 * Insert a Magic Context-owned Pi compaction entry: it keeps the first user
 * message at or after `hiddenMessages` and the 600 entries that follow, then the
 * later entries continue the chain after the compaction.
 */
function insertMagicContextCompaction(
	entries: SessionEntry[],
	hiddenMessages: number,
): void {
	const firstKeptSequence = Math.ceil(hiddenMessages / 6) * 6;
	const id = (sequence: number) =>
		`synthetic-entry-${String(sequence).padStart(6, "0")}`;
	const firstKeptIndex = entries.findIndex(
		(entry) => entry.id === id(firstKeptSequence),
	);
	if (firstKeptIndex < 0) return;
	const lastKeptIndex = Math.min(firstKeptIndex + 599, entries.length - 1);
	const lastKept = entries[lastKeptIndex];
	if (!lastKept) return;
	const compaction = {
		type: "compaction",
		id: "synthetic-compaction",
		parentId: lastKept.id,
		timestamp: lastKept.timestamp,
		summary: "Synthetic Magic Context history summary.",
		firstKeptEntryId: id(firstKeptSequence),
		tokensBefore: 1_000_000,
		fromHook: true,
		details: { source: "magic-context" },
	} as unknown as SessionEntry;
	const next = entries[lastKeptIndex + 1];
	if (next) (next as { parentId: string | null }).parentId = compaction.id;
	entries.splice(lastKeptIndex + 1, 0, compaction);
}

export function buildAccumulationPasses(
	fixture: PerfFixture,
	requestedPoints: readonly number[],
): PerfPassInput[] {
	const messageEntryIndexes: number[] = [];
	for (let index = 0; index < fixture.entries.length; index += 1) {
		if (fixture.entries[index]?.type === "message")
			messageEntryIndexes.push(index);
	}
	if (messageEntryIndexes.length === 0) return [];

	const uniquePoints = [
		...new Set(requestedPoints.map((point) => Math.max(1, Math.floor(point)))),
	]
		.filter((point) => point <= messageEntryIndexes.length)
		.sort((a, b) => a - b);
	if (uniquePoints.at(-1) !== messageEntryIndexes.length)
		uniquePoints.push(messageEntryIndexes.length);

	return uniquePoints.map((requestedMessages) => {
		const endIndex =
			messageEntryIndexes[requestedMessages - 1] ?? fixture.entries.length - 1;
		const prefix = fixture.entries.slice(0, endIndex + 1);
		const leafId = prefix.at(-1)?.id ?? null;
		const byId = new Map(prefix.map((entry) => [entry.id, entry]));
		const branchEntries = resolveBranch(prefix, leafId, byId);
		const context = buildSessionContext(prefix, leafId, byId);
		return {
			requestedMessages,
			messages: context.messages as unknown[],
			branchEntries,
		};
	});
}

function resolveBranch(
	entries: readonly SessionEntry[],
	leafId: string | null,
	byId: ReadonlyMap<string, SessionEntry>,
): SessionEntry[] {
	if (!leafId) return [];
	const reversed: SessionEntry[] = [];
	const visited = new Set<string>();
	let current = byId.get(leafId);
	while (current && !visited.has(current.id)) {
		visited.add(current.id);
		reversed.push(current);
		current =
			current.parentId === null ? undefined : byId.get(current.parentId);
	}
	if (reversed.length === 0) return [...entries];
	return reversed.reverse();
}

function emptyUsage(): Record<string, unknown> {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}
