import { join, resolve } from "node:path";
import type {
	RetrospectiveProjectSession,
	RetrospectiveRawMessage,
	RetrospectiveRawProvider,
	RetrospectiveSinceRead,
} from "@magic-context/core/features/magic-context/dreamer/retrospective-raw-provider";
import { readSessionActivity } from "@magic-context/core/features/magic-context/session-activity";
import type { Database } from "@magic-context/core/shared/sqlite";
import { sessionEntries, sessionHeaders } from "./bounded-session-reader";
import { resolvePiCodingAgentModule } from "./pi-session-api";

interface PiSessionInfoLike {
	id?: unknown;
	path?: unknown;
	cwd?: unknown;
	modified?: unknown;
}

interface PiMessageEntryLike {
	type?: unknown;
	id?: unknown;
	message?: unknown;
}

interface PiUserMessageLike {
	role?: unknown;
	timestamp?: unknown;
	content?: unknown;
}

export interface PiRetrospectiveRawProviderDeps {
	projectCwd: string;
	contextDb?: Database;
	sessionDir?: string;
	listSessions?: (sessionDir?: string) => unknown[] | Promise<unknown[]>;
	loadEntriesFromFile?: (filePath: string) => unknown[] | Promise<unknown[]>;
}

export class PiRetrospectiveRawProvider implements RetrospectiveRawProvider {
	private readonly sessionPathById = new Map<string, string>();

	constructor(private readonly deps: PiRetrospectiveRawProviderDeps) {}

	async listProjectSessions(
		_projectIdentity: string,
	): Promise<RetrospectiveProjectSession[]> {
		let directory = this.deps.sessionDir;
		if (!directory && !this.deps.listSessions) {
			const mod = (await resolvePiCodingAgentModule()) as {
				getAgentDir?: () => string;
			};
			if (!mod.getAgentDir) return [];
			directory = join(mod.getAgentDir(), "sessions");
		}
		const sessions = this.deps.listSessions
			? await this.deps.listSessions(directory)
			: directory
				? sessionHeaders(directory, !this.deps.sessionDir)
				: [];
		const projectCwd = resolve(this.deps.projectCwd);
		const result: RetrospectiveProjectSession[] = [];
		this.sessionPathById.clear();

		for (const raw of sessions) {
			const info = raw as PiSessionInfoLike | null;
			if (!info || typeof info !== "object") continue;
			if (typeof info.id !== "string" || typeof info.path !== "string")
				continue;
			if (typeof info.cwd !== "string" || resolve(info.cwd) !== projectCwd)
				continue;

			const activity = this.deps.contextDb
				? readSessionActivity(this.deps.contextDb, info.id)
				: typeof info.modified === "number"
					? info.modified
					: undefined;
			if (this.deps.contextDb && activity === undefined) continue;
			this.sessionPathById.set(info.id, info.path);
			result.push({
				sessionId: info.id,
				path: info.path,
				updatedAt: activity,
			});
		}

		return result.sort((a, b) => (a.updatedAt ?? 0) - (b.updatedAt ?? 0));
	}

	async readUserMessagesSince(
		sessionId: string,
		sinceMs: number,
		capPerSession: number,
	): Promise<RetrospectiveSinceRead> {
		const limit = Math.max(1, Math.floor(capPerSession));
		const messages = await this.selectUserEntries(
			sessionId,
			(ts) => ts > sinceMs,
			limit + 1,
			false,
		);
		return {
			messages: messages.slice(0, limit),
			truncated: messages.length > limit,
		};
	}

	async readOldestMessageTimesSince(
		sessionIds: readonly string[],
		sinceMs: number,
	): Promise<Map<string, number>> {
		const out = new Map<string, number>();
		for (const sessionId of sessionIds) {
			const [oldest] = await this.selectUserEntries(
				sessionId,
				(ts) => ts > sinceMs,
				1,
				false,
			);
			if (oldest) out.set(sessionId, oldest.ts);
		}
		return out;
	}

	async readUserMessagesBefore(
		sessionId: string,
		beforeMs: number,
		count: number,
	): Promise<RetrospectiveRawMessage[]> {
		return this.selectUserEntries(
			sessionId,
			(ts) => ts <= beforeMs,
			Math.max(1, Math.floor(count)),
			true,
		);
	}

	private async selectUserEntries(
		sessionId: string,
		eligible: (ts: number) => boolean,
		limit: number,
		newest: boolean,
	): Promise<RetrospectiveRawMessage[]> {
		const filePath = this.sessionPathById.get(sessionId);
		if (!filePath) return [];
		const kept: RetrospectiveRawMessage[] = [];
		try {
			const entries = this.deps.loadEntriesFromFile
				? await this.deps.loadEntriesFromFile(filePath)
				: sessionEntries(filePath);
			let ordinal = 0;
			for (const entry of entries) {
				const row = normalizePiUserEntry(entry, sessionId, ++ordinal);
				if (!row || !eligible(row.ts)) continue;
				kept.push(row);
				kept.sort((a, b) => a.ts - b.ts || a.ordinal - b.ordinal);
				if (kept.length > limit) {
					if (newest) kept.shift();
					else kept.pop();
				}
			}
		} catch {
			return [];
		}
		// Timestamps need not be monotonic in imported/branched sessions. Scan to
		// EOF but retain only the requested prefix (or overlap suffix), not history.
		return kept;
	}
}

function normalizePiUserEntry(
	entry: unknown,
	sessionId: string,
	ordinal: number,
): RetrospectiveRawMessage | null {
	const e = entry as PiMessageEntryLike | null;
	if (!e || typeof e !== "object" || e.type !== "message") return null;
	const message = e.message as PiUserMessageLike | null;
	if (!message || typeof message !== "object") return null;
	if (message.role !== "user" || typeof message.timestamp !== "number")
		return null;
	const text = extractPiTextContent(message.content).trim();
	if (!text) return null;
	return {
		sessionId,
		ordinal,
		role: "user",
		text,
		ts: message.timestamp,
	};
}

function extractPiTextContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.flatMap((part) => {
			if (part === null || typeof part !== "object") return [];
			const record = part as Record<string, unknown>;
			return record.type === "text" && typeof record.text === "string"
				? [record.text]
				: [];
		})
		.join("\n");
}
