import { describe, expect, it } from "bun:test";
import { compareMemorySelectionPriority, type MemorySelectionCandidate } from "./memory-selection";

function candidate(
    id: number,
    importance: number | null,
    lastSeenAt: number | null,
): MemorySelectionCandidate {
    return {
        id,
        importance: importance as number,
        status: "active",
        lastSeenAt,
        verifiedAt: null,
    } as MemorySelectionCandidate;
}

describe("compareMemorySelectionPriority", () => {
    it("orders memories without an importance by reinforcement recency, as the Rust module does", () => {
        // The Rust module (m0_compose.rs memory_selection_order) ranks these [2, 3, 1]:
        // newest reinforcement first, never-reinforced last.
        const memories = [
            candidate(1, null, null),
            candidate(2, null, 200),
            candidate(3, null, 100),
        ];
        expect([...memories].sort(compareMemorySelectionPriority).map((m) => m.id)).toEqual([
            2, 3, 1,
        ]);
    });

    it("ranks a missing importance below every set importance", () => {
        const memories = [candidate(1, null, 500), candidate(2, 1, null), candidate(3, 5, null)];
        expect([...memories].sort(compareMemorySelectionPriority).map((m) => m.id)).toEqual([
            3, 2, 1,
        ]);
    });
});
