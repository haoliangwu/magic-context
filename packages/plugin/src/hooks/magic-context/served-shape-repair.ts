import {
    readReplayEnvelope,
    updateReplayDocument,
} from "../../features/magic-context/storage-replay-document";
import type { Database } from "../../shared/sqlite";
import { stripPersistedAssistantText } from "./tag-content-primitives";
import type { MessageLike } from "./tag-messages";

type TextDecision = { index: number; text: string };
type Candidate = TextDecision & { requiresPermission?: boolean };
type Decisions = Record<string, TextDecision[]>;
const sources = new WeakMap<MessageLike["info"], Candidate[]>();

/** Remember source slots before tagging or inline stripping can erase their provenance. */
export function markServedShapeRepair(
    info: MessageLike["info"],
    parts: TextDecision[],
    requiresPermission = false,
): void {
    const merged = new Map((sources.get(info) ?? []).map((part) => [part.index, part]));
    for (const part of parts) merged.set(part.index, { ...part, requiresPermission });
    if (merged.size) sources.set(info, [...merged.values()]);
}

function parseDecisions(value: unknown): Decisions {
    if (value === undefined) return {};
    if (!value || typeof value !== "object" || Array.isArray(value))
        throw new Error("Invalid served-shape replay decisions");
    for (const entries of Object.values(value)) {
        if (
            !Array.isArray(entries) ||
            entries.some(
                (entry) =>
                    !entry ||
                    !Number.isSafeInteger(entry.index) ||
                    entry.index < 0 ||
                    typeof entry.text !== "string" ||
                    !entry.text.trim(),
            )
        )
            throw new Error("Invalid served-shape text decision");
    }
    return value as Decisions;
}

function readDecisions(db: Database, sessionID: string): Decisions {
    return parseDecisions(readReplayEnvelope(db, sessionID).servedShapeRepair);
}

/** Only undecided parts with positive prior-empty evidence originate a rebuild. */
export function prepareServedShapeRepair(
    db: Database,
    sessionID: string,
    messages: MessageLike[],
    readPreviouslyServed?: () => readonly unknown[] | null,
    snapshot?: { servedShapeRepair?: unknown },
) {
    let decisions = snapshot
        ? parseDecisions(snapshot.servedShapeRepair)
        : readDecisions(db, sessionID);
    const collectPending = (): Record<string, Candidate[]> => {
        const pending: Record<string, Candidate[]> = {};
        for (const message of messages) {
            const id = message.info.id;
            if (typeof id !== "string") continue;
            const candidates = (sources.get(message.info) ?? []).filter(
                ({ index }) => !decisions[id]?.some((part) => part.index === index),
            );
            if (candidates.length) pending[id] = candidates;
        }
        return pending;
    };
    const pending = collectPending();
    // An unseen suffix gets its first representation without invalidating a
    // prefix. Only positive evidence of an old empty slot authorizes a rebuild.
    let previouslyServed: readonly unknown[] | null = null;
    try {
        const evidence = Object.keys(pending).length ? readPreviouslyServed?.() : null;
        if (Array.isArray(evidence)) previouslyServed = evidence;
    } catch {
        // Unreadable previously served messages cannot authorize a prior-empty repair.
    }
    const provenUnserved = new Set<string>();
    let needsRebuild = false;
    for (const id of Object.keys(pending)) {
        if (!previouslyServed) continue;
        const matches = previouslyServed.filter((value): value is MessageLike => {
            if (!value || typeof value !== "object") return false;
            const message = value as Partial<MessageLike>;
            return message.info?.id === id;
        });
        if (!matches.length) provenUnserved.add(id);
        const previous = matches.length === 1 ? matches[0] : undefined;
        needsRebuild ||=
            previous !== undefined &&
            Array.isArray(previous.parts) &&
            pending[id].some(({ index }) => {
                const part = previous.parts[index] as { type?: string; text?: string } | undefined;
                return part?.type === "text" && part.text === "";
            });
    }
    return {
        pending: Object.keys(pending).length > 0,
        needsRebuild,
        get messageIDs() {
            return new Set(Object.keys(decisions));
        },
        apply(allowed: boolean): number {
            const eligible: Decisions = {};
            for (const [id, candidates] of Object.entries(collectPending())) {
                const parts = candidates
                    .filter(
                        ({ requiresPermission }) =>
                            allowed ||
                            (!requiresPermission && !needsRebuild && provenUnserved.has(id)),
                    )
                    .map(({ index, text }) => ({ index, text }));
                if (parts.length) eligible[id] = parts;
            }
            if (Object.keys(eligible).length) {
                if (
                    !updateReplayDocument(db, sessionID, (doc) => {
                        doc.version = 2;
                        const current = parseDecisions(doc.servedShapeRepair);
                        for (const [id, parts] of Object.entries(eligible)) {
                            current[id] = [
                                ...(current[id] ?? []),
                                ...parts.filter(
                                    ({ index }) =>
                                        !current[id]?.some((part) => part.index === index),
                                ),
                            ];
                        }
                        doc.servedShapeRepair = current;
                        return true;
                    })
                )
                    throw new Error("Could not persist served-shape repair");
                // Replay the CAS winner, never an uncommitted local choice.
                decisions = readDecisions(db, sessionID);
            }
            let changed = 0;
            for (const message of messages) {
                const id = message.info.id;
                if (typeof id !== "string") continue;
                for (const decision of decisions[id] ?? []) {
                    const part = message.parts[decision.index] as
                        | { type?: string; text?: string }
                        | undefined;
                    if (part?.type !== "text") continue;
                    // An intentional drop/compression wins over a text-slot repair.
                    if (
                        typeof part.text !== "string" ||
                        stripPersistedAssistantText(part.text).trim()
                    )
                        continue;
                    if (part.text !== decision.text) {
                        part.text = decision.text;
                        changed++;
                    }
                }
            }
            return changed;
        },
    };
}
