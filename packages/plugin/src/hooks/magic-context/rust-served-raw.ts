import { createHash } from "node:crypto";
import {
    type ReplayDocument,
    readReplayEnvelope,
    updateReplayDocument,
} from "../../features/magic-context/storage-replay-document";
import type { Database } from "../../shared/sqlite";
import { stableStringify } from "../../shared/stable-json";
import { EmergencyFailClosedError } from "./emergency-fail-closed";
import { encodeOpenCodeMessagesToCk } from "./module-wire";
import type { MessageLike } from "./transform-operations";

interface ServedRawPart {
    messageId: string;
    index: number;
    partId?: string;
    digest: string;
    blockIds: string[];
}

export interface RustRawRebuild {
    identity: string;
    reason: "source_removed" | "source_changed" | "candidate_loss" | "candidate_conflict";
    messageIds: string[];
    firstBlockId: string;
    pending: boolean;
}

export class RustServedRawConflict extends EmergencyFailClosedError {
    constructor(
        readonly reason: RustRawRebuild["reason"],
        readonly messageIds: string[],
        readonly firstBlockId: string,
    ) {
        super(`Rust served-raw conflict: ${reason} at ${firstBlockId}`);
    }
}

function partDigest(part: unknown): string {
    // Native records cross a JSON boundary: shared JavaScript references must
    // compare like their serialized value copies, not like circular identities.
    const serialized = JSON.stringify(part);
    return createHash("sha256")
        .update(stableStringify(serialized === undefined ? undefined : JSON.parse(serialized)))
        .digest("hex");
}

function records(doc: ReplayDocument): ServedRawPart[] {
    if (doc.rustServedRaw === undefined) return [];
    if (!Array.isArray(doc.rustServedRaw))
        throw new EmergencyFailClosedError("Invalid Rust served-raw evidence");
    for (const row of doc.rustServedRaw) {
        if (
            !row ||
            typeof row.messageId !== "string" ||
            !Number.isSafeInteger(row.index) ||
            row.index < 0 ||
            (row.partId !== undefined && typeof row.partId !== "string") ||
            typeof row.digest !== "string" ||
            !/^[a-f0-9]{64}$/.test(row.digest) ||
            !Array.isArray(row.blockIds) ||
            !row.blockIds.every((id: unknown) => typeof id === "string")
        ) {
            throw new EmergencyFailClosedError("Invalid Rust served-raw part");
        }
    }
    return doc.rustServedRaw;
}

export function rustRawRebuild(db: Database, sessionId: string): RustRawRebuild | undefined {
    const value = readReplayEnvelope(db, sessionId).rustRawRebuild as RustRawRebuild | undefined;
    if (value === undefined) return undefined;
    if (
        !value ||
        typeof value.identity !== "string" ||
        !/^[a-f0-9]{64}$/.test(value.identity) ||
        !["source_removed", "source_changed", "candidate_loss", "candidate_conflict"].includes(
            value.reason,
        ) ||
        !Array.isArray(value.messageIds) ||
        !value.messageIds.every((id) => typeof id === "string") ||
        typeof value.firstBlockId !== "string" ||
        typeof value.pending !== "boolean"
    ) {
        throw new EmergencyFailClosedError("Invalid Rust raw-rebuild request");
    }
    return value;
}

export function servedRawBlockIds(db: Database, sessionId: string): string[] {
    return records(readReplayEnvelope(db, sessionId)).flatMap((row) => row.blockIds);
}

function sourcePart(
    row: ServedRawPart,
    message: MessageLike | undefined,
): Record<string, unknown> | undefined {
    return (
        row.partId === undefined
            ? message?.parts[row.index]
            : message?.parts.find((part) => (part as Record<string, unknown>)?.id === row.partId)
    ) as Record<string, unknown> | undefined;
}

function conflict(row: ServedRawPart, reason: RustRawRebuild["reason"]): RustServedRawConflict {
    return new RustServedRawConflict(
        reason,
        [row.messageId],
        row.blockIds[0] ?? `${row.messageId}#0`,
    );
}

/** Detect source edits before execution, so a saved last-known-good request cannot resurrect a deletion. */
export function checkRustServedRawIngress(
    db: Database,
    sessionId: string,
    input: MessageLike[],
): void {
    const rows = records(readReplayEnvelope(db, sessionId));
    if (!rows.length) return;
    const byId = new Map(input.map((message) => [message.info.id, message]));
    const changed = rows.filter(
        (row) => partDigest(sourcePart(row, byId.get(row.messageId))) !== row.digest,
    );
    const first = changed[0];
    if (!first) return;
    throw new RustServedRawConflict(
        sourcePart(first, byId.get(first.messageId)) === undefined
            ? "source_removed"
            : "source_changed",
        [...new Set(changed.map((row) => row.messageId))],
        first.blockIds[0] ?? `${first.messageId}#0`,
    );
}

/** After refusing a source/candidate conflict, persist the next turn's explicit prefix-rebuild request. */
export function requestRustRawRebuild(
    db: Database,
    sessionId: string,
    error: RustServedRawConflict,
): void {
    if (
        !updateReplayDocument(db, sessionId, (doc) => {
            const previous = doc.rustRawRebuild as RustRawRebuild | undefined;
            if (
                previous?.pending &&
                previous.reason === error.reason &&
                previous.firstBlockId === error.firstBlockId &&
                error.messageIds.every((id) => previous.messageIds.includes(id))
            )
                return false;
            const messageIds = [
                ...new Set([
                    ...(previous?.pending ? previous.messageIds : []),
                    ...error.messageIds,
                ]),
            ];
            const identity = partDigest([
                previous?.identity ?? "",
                error.reason,
                messageIds,
                error.firstBlockId,
            ]);
            doc.version = 2;
            doc.rustRawRebuild = {
                identity,
                reason: error.reason,
                messageIds,
                firstBlockId: error.firstBlockId,
                pending: true,
            } satisfies RustRawRebuild;
            return true;
        })
    )
        throw new EmergencyFailClosedError("Cannot persist Rust raw-rebuild request");
}

/** Save message/part coordinates and a key-order-independent digest, not another copy of native history. */
export function noteRustServedRaw(
    db: Database,
    sessionId: string,
    input: MessageLike[],
    served: MessageLike[],
): void {
    const additions: ServedRawPart[] = [];
    const byId = new Map(
        served
            .filter((message) => typeof message?.info?.id === "string")
            .map((message) => [message.info.id, message]),
    );
    for (const message of input) {
        const visible = byId.get(message.info.id);
        if (!visible) continue;
        let offset = 0;
        for (const [index, value] of message.parts.entries()) {
            if (!value || typeof value !== "object") continue;
            const part = value as Record<string, unknown>;
            const count = (
                encodeOpenCodeMessagesToCk([{ ...message, parts: [part] }])[0].ck
                    .content as unknown[]
            ).length;
            const actual =
                typeof part.id === "string"
                    ? visible.parts.find(
                          (candidate) => (candidate as Record<string, unknown>)?.id === part.id,
                      )
                    : visible.parts[index];
            const status = (part.state as { status?: string } | undefined)?.status;
            const reachesProvider =
                !(part.type === "text" && part.ignored === true) &&
                ![
                    "compaction",
                    "step-start",
                    "step-finish",
                    "snapshot",
                    "patch",
                    "agent",
                    "retry",
                ].includes(String(part.type)) &&
                (part.type !== "tool" || status === "completed" || status === "error");
            if (reachesProvider && count > 0) {
                const digest = partDigest(part);
                if (actual === part || partDigest(actual) === digest) {
                    additions.push({
                        messageId: message.info.id as string,
                        index,
                        ...(typeof part.id === "string" ? { partId: part.id } : {}),
                        digest,
                        blockIds: Array.from(
                            { length: count },
                            (_, i) => `${message.info.id}#${offset + i}`,
                        ),
                    });
                }
            }
            offset += count;
        }
    }
    if (!additions.length) return;
    if (
        !updateReplayDocument(db, sessionId, (doc) => {
            const rows = records(doc);
            const key = (row: ServedRawPart) =>
                stableStringify([row.messageId, row.partId ?? row.index]);
            const merged = new Map(rows.map((row) => [key(row), row]));
            for (const row of additions) merged.set(key(row), row);
            const next = [...merged.values()];
            if (stableStringify(rows) === stableStringify(next)) return false;
            doc.version = 2;
            doc.rustServedRaw = next;
            return true;
        })
    )
        throw new EmergencyFailClosedError("Cannot persist Rust served-raw evidence");
}

/** Restore bytes only after matching the current input part's digest. Missing source is never replayed. */
export function preserveRustServedRaw(
    db: Database,
    sessionId: string,
    output: MessageLike[],
    input: MessageLike[] = output,
    reconstruct: ReadonlySet<string> = new Set(),
    covered: ReadonlySet<string> = new Set(),
): boolean {
    const rows = records(readReplayEnvelope(db, sessionId));
    if (!rows.length) return false;
    const sources = new Map(input.map((message) => [message.info.id, message]));
    const byId = new Map(output.map((message) => [message.info.id, message]));
    let repaired = false;
    for (const row of rows) {
        if (covered.has(row.messageId)) continue;
        const original = sources.get(row.messageId);
        const source = sourcePart(row, original);
        if (!original || !source) throw conflict(row, "source_removed");
        if (partDigest(source) !== row.digest) throw conflict(row, "source_changed");
        let message = byId.get(row.messageId);
        if (!message) {
            if (!reconstruct.has(row.messageId)) throw conflict(row, "candidate_loss");
            const sourceIndex = input.indexOf(original);
            const next = output.findIndex(
                (candidate) =>
                    input.findIndex((entry) => entry.info.id === candidate.info.id) > sourceIndex,
            );
            message = structuredClone(original);
            output.splice(next < 0 ? output.length : next, 0, message);
            byId.set(row.messageId, message);
            repaired = true;
        }
        const parts = message.parts as Record<string, unknown>[];
        if (row.partId === undefined) {
            const candidate = parts[row.index];
            if (partDigest(candidate) === row.digest) continue;
            const reversibleTag =
                source.type === "text" &&
                typeof source.text === "string" &&
                typeof candidate?.text === "string" &&
                /^§\d+§ /.test(candidate.text) &&
                candidate.text.replace(/^§\d+§ /, "") === source.text &&
                partDigest({ ...candidate, text: source.text }) === row.digest;
            if (!reversibleTag) {
                if (!reconstruct.has(row.messageId)) throw conflict(row, "candidate_conflict");
                // A recorded rebuild can reconstruct the authoritative message; it
                // does not turn a different ID-less neighbor into an identity match.
                message.parts = structuredClone(original.parts);
                repaired = true;
                continue;
            }
            parts[row.index] = structuredClone(source);
            continue;
        }
        const matches = parts.flatMap((part, i) => (part.id === row.partId ? [i] : []));
        if (matches.length > 1) throw conflict(row, "candidate_conflict");
        const index = matches[0];
        if (index !== undefined) {
            if (partDigest(parts[index]) !== row.digest) parts[index] = structuredClone(source);
        } else if (
            ["reasoning", "thinking", "redacted_thinking"].includes(String(source.type)) ||
            reconstruct.has(row.messageId)
        ) {
            parts.splice(row.index, 0, structuredClone(source));
            repaired = true;
        } else throw conflict(row, "candidate_loss");
    }
    return repaired;
}

/** A successful authorized output retires only replaced digests and acknowledges its recovery request atomically. */
export function releaseRustServedRaw(
    db: Database,
    sessionId: string,
    output: MessageLike[],
    rebuiltIdentity?: string,
): void {
    const snapshot = readReplayEnvelope(db, sessionId);
    if (
        !records(snapshot).length &&
        !(snapshot.rustRawRebuild as RustRawRebuild | undefined)?.pending
    )
        return;
    const byId = new Map(output.map((message) => [message.info.id, message]));
    if (
        !updateReplayDocument(db, sessionId, (doc) => {
            const rows = records(doc);
            const kept = rows.filter(
                (row) => partDigest(sourcePart(row, byId.get(row.messageId))) === row.digest,
            );
            const recovery = doc.rustRawRebuild as RustRawRebuild | undefined;
            const acknowledged = recovery?.pending && recovery.identity === rebuiltIdentity;
            if (kept.length === rows.length && !acknowledged) return false;
            doc.version = 2;
            doc.rustServedRaw = kept;
            if (acknowledged) doc.rustRawRebuild = { ...recovery, pending: false };
            return true;
        })
    )
        throw new EmergencyFailClosedError("Cannot release Rust served-raw evidence");
}
