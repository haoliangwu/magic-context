import type { Memory } from "./types";

/** Fields that decide which equal-importance memory survives a bound render budget. */
export type MemorySelectionCandidate = Pick<
    Memory,
    "id" | "importance" | "status" | "lastSeenAt" | "verifiedAt"
>;

/**
 * The newest evidence that a memory is still useful. Exact-dedup re-observation
 * advances last_seen_at (and seen_count) in storage-memory.ts; verification writes
 * verified_at. Taking the newer timestamp lets either reinforcement path carry signal.
 */
export function memoryReinforcementAt(memory: MemorySelectionCandidate): number | null {
    const timestamps = [memory.lastSeenAt, memory.verifiedAt].filter(
        (value): value is number => typeof value === "number" && Number.isFinite(value),
    );
    return timestamps.length > 0 ? Math.max(...timestamps) : null;
}

/** Permanent first, then importance and reinforcement recency descending. */
export function compareMemorySelectionPriority(
    left: MemorySelectionCandidate,
    right: MemorySelectionCandidate,
): number {
    if (left.status === "permanent" && right.status !== "permanent") return -1;
    if (right.status === "permanent" && left.status !== "permanent") return 1;

    // A missing importance ranks below every set one. Two missing importances tie and fall
    // through to reinforcement recency; subtracting them gave -Infinity - -Infinity = NaN,
    // which sort() reads as "equal", so such memories kept their input order instead.
    const leftImportance = left.importance ?? Number.NEGATIVE_INFINITY;
    const rightImportance = right.importance ?? Number.NEGATIVE_INFINITY;
    if (leftImportance !== rightImportance) return rightImportance > leftImportance ? 1 : -1;

    const leftReinforcedAt = memoryReinforcementAt(left);
    const rightReinforcedAt = memoryReinforcementAt(right);
    if (leftReinforcedAt === null && rightReinforcedAt === null) {
        return left.id - right.id;
    }
    if (leftReinforcedAt === null) return 1;
    if (rightReinforcedAt === null) return -1;
    return rightReinforcedAt - leftReinforcedAt;
}
