import {
    assertOpenCodeStoreGeneration,
    resolveOpenCodeDbPath,
    sourceOpenCodeDatabaseFilename,
} from "../shared/opencode-db-path";
import { Database } from "../shared/sqlite";

/** Compatibility export; shared/opencode-db-path.ts is the single filename authority. */
export function sourceDatabaseFilename(
    channel: string,
    env: NodeJS.ProcessEnv = process.env,
): string {
    return sourceOpenCodeDatabaseFilename("v2", channel, env);
}

/** GA data root resolved by the shared host-generation-aware resolver. */
export function gaDatabasePath(
    dataHome: string,
    channel = "latest",
    env: NodeJS.ProcessEnv = process.env,
): string {
    return resolveOpenCodeDbPath("v2", { dataHome, channel, env }).path;
}

// GA core-session-message.excerpt.js and oc-audit-7a31b5c0f7.md:166-184.
export type MessageType =
    | "agent-switched"
    | "model-switched"
    | "location-switched"
    | "user"
    | "synthetic"
    | "system"
    | "skill"
    | "shell"
    | "assistant"
    | "compaction"
    | "idle";
export interface MessageData {
    [key: string]: unknown;
    content?: Array<Record<string, unknown>>;
    text?: string;
    finish?: string;
    error?: unknown;
    model?: { id: string; providerID: string; variant?: string };
    tokens?: {
        input: number;
        output: number;
        reasoning: number;
        cache: { read: number; write: number };
    };
    time?: { created: number; completed?: number; streamed?: number };
}
export interface IdleData extends MessageData {
    outcome: "succeeded" | "failed" | "interrupted";
}
export interface CompactionData extends MessageData {
    status: string;
    summary?: string;
    recent?: string;
}
export interface StoreRow<T extends MessageType = MessageType> {
    id: string;
    session_id: string;
    type: T;
    seq: number;
    data: T extends "idle" ? IdleData : T extends "compaction" ? CompactionData : MessageData;
}
interface RawRow extends Omit<StoreRow, "data"> {
    data: string;
}

function decode(row: RawRow): StoreRow {
    const data: unknown = JSON.parse(row.data);
    if (!data || typeof data !== "object" || Array.isArray(data)) {
        throw new Error(`Invalid session_message data at seq ${row.seq}`);
    }
    if (
        row.type === "idle" &&
        !["succeeded", "failed", "interrupted"].includes(String((data as IdleData).outcome))
    ) {
        throw new Error(`Invalid idle outcome at seq ${row.seq}`);
    }
    return { ...row, data: data as MessageData };
}

/** Opens an existing store read-only; missing/corrupt stores propagate errors, never an empty history. */
export class V2StoreReader {
    private readonly db: Database;
    constructor(path: string) {
        this.db = new Database(path, { readonly: true, fileMustExist: true });
        try {
            assertOpenCodeStoreGeneration(this.db, "v2", path);
        } catch (error) {
            this.db.close();
            throw error;
        }
    }
    close(): void {
        this.db.close();
    }

    /** Exclusive cursor, ascending seq. IDs are not chronological in the v2 store. */
    page(
        sessionID: string,
        options: { after?: number; limit?: number; type?: MessageType } = {},
    ): { rows: StoreRow[]; cursor: number | undefined } {
        const limit = options.limit ?? 100;
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10000)
            throw new Error("Invalid page limit");
        const after = options.after ?? -1;
        if (!Number.isSafeInteger(after)) throw new Error("Invalid seq cursor");
        const rows = (
            this.db
                .prepare(`SELECT id, session_id, type, seq, data FROM session_message
            WHERE session_id = ? AND seq > ? ${options.type ? "AND type = ?" : ""}
            ORDER BY seq ASC LIMIT ?`)
                .all(
                    ...(options.type
                        ? [sessionID, after, options.type, limit]
                        : [sessionID, after, limit]),
                ) as RawRow[]
        ).map(decode);
        return { rows, cursor: rows.at(-1)?.seq };
    }
    // GA core mime-vz9r8jjr.js:45-54: latest boundary selects completed checkpoints only.
    latestCompaction(sessionID: string): StoreRow<"compaction"> | undefined {
        const row = this.db
            .prepare(`SELECT id, session_id, type, seq, data FROM session_message
            WHERE session_id = ? AND type = 'compaction' AND json_extract(data, '$.status') = 'completed'
            ORDER BY seq DESC LIMIT 1`)
            .get(sessionID) as RawRow | undefined;
        return row ? (decode(row) as StoreRow<"compaction">) : undefined;
    }
    idleRows(sessionID: string, after = -1): StoreRow<"idle">[] {
        return this.all(sessionID, after, "idle") as StoreRow<"idle">[];
    }
    latestSequence(sessionID: string): number {
        const row = this.db
            .prepare("SELECT MAX(seq) AS seq FROM session_message WHERE session_id = ?")
            .get(sessionID) as { seq: number | null } | undefined;
        return typeof row?.seq === "number" ? row.seq : -1;
    }
    latestAssistant(sessionID: string): StoreRow<"assistant"> | undefined {
        const row = this.db
            .prepare(`SELECT id, session_id, type, seq, data FROM session_message
            WHERE session_id = ? AND type = 'assistant'
            ORDER BY seq DESC LIMIT 1`)
            .get(sessionID) as RawRow | undefined;
        return row ? (decode(row) as StoreRow<"assistant">) : undefined;
    }
    /** Include the completed checkpoint itself, matching the host history cut. */
    window(sessionID: string): StoreRow[] {
        return this.db.transaction(() => {
            const cut = this.latestCompaction(sessionID);
            return this.all(sessionID, cut ? cut.seq - 1 : -1);
        })();
    }
    /** Full retained source is needed to restore unarchived rows hidden by a host cut. */
    history(sessionID: string): StoreRow[] {
        return this.all(sessionID, -1);
    }
    private all(sessionID: string, after: number, type?: MessageType): StoreRow[] {
        const rows: StoreRow[] = [];
        for (;;) {
            const page = this.page(sessionID, { after, type });
            rows.push(...page.rows);
            if (page.rows.length < 100 || page.cursor === undefined) return rows;
            after = page.cursor;
        }
    }
}
