import { sessionLog } from "../../shared/logger";
import type { MessageLike } from "./transform-operations";

/**
 * What a Rust-mode adapter exposes to code outside it that can serve its
 * last-known-good (LKG) slot. The outer messages-transform wrapper replays the
 * slot when the adapter's pass throws; that replay is provider-visible, so the
 * adapter must enter its frozen representation exactly as if it had served the
 * replay itself, and the wrapper must admit the replay the way the adapter would.
 */
export interface RustLkgReplayParticipant {
    /**
     * When this adapter last started a pass for the session, as a stamp from
     * `nextRustPassStamp` (larger is later), or undefined when it never has.
     */
    lastPassStamp(sessionId: string): number | undefined;
    /** Enter or keep the freeze after an LKG replay served outside the adapter. */
    enterFreezeFromExternalServe(sessionId: string, inputCount: number): void;
    /**
     * The adapter's own context-fit admission for an LKG replay of `messages`,
     * with the model resolved from the pass's `inputMessages` as the adapter does.
     */
    replayFits(sessionId: string, messages: MessageLike[], inputMessages: MessageLike[]): boolean;
    /**
     * True when the adapter would fail closed for this session right now (usage in
     * its emergency band, or a proven provider overflow), where it admits no LKG
     * replay. True as well when that cannot be determined.
     */
    emergencyFailClosed(sessionId: string, inputMessages: MessageLike[]): boolean;
    /**
     * Remove from a replayed array the thinking blocks this session has already
     * stopped sending (the ids saved in its binding-mismatch set), exactly as the
     * adapter's own replay does: same database, and the same provider (resolved
     * from the pass's input messages) deciding how a block is removed.
     */
    stripPersistedReasoning(
        sessionId: string,
        messages: MessageLike[],
        inputMessages: MessageLike[],
    ): void;
}

// Held weakly: OpenCode can drop an adapter without telling it (an instance is
// disposed and opened again in the same process), and the registry must not keep
// a dropped adapter, with its per-session state, alive. Each adapter keeps its own
// participant reachable for as long as the adapter itself is.
const participants = new Set<WeakRef<RustLkgReplayParticipant>>();
let passStamp = 0;

/** A process-wide increasing stamp for the start of an adapter pass. */
export function nextRustPassStamp(): number {
    passStamp += 1;
    return passStamp;
}

/** Register an adapter. Returns the matching unregister function; call it on dispose. */
export function registerRustLkgReplayParticipant(
    participant: RustLkgReplayParticipant,
): () => void {
    const ref = new WeakRef(participant);
    participants.add(ref);
    return () => {
        participants.delete(ref);
    };
}

/**
 * The adapter that serves this session in Rust mode, or undefined in TypeScript
 * mode. Among adapters that have run the session, the one that ran it most
 * recently is the live one: after an instance is disposed and opened again in the
 * same process, the old adapter may still hold state for the session but no longer
 * runs it. With no adapter that has run the session, a single registered adapter
 * is the only one that can (the wrapper may have refused before the adapter ever
 * saw it in this process); with several the session is not attributed.
 */
export function resolveRustLkgReplayParticipant(
    sessionId: string,
): RustLkgReplayParticipant | undefined {
    let latest: RustLkgReplayParticipant | undefined;
    let latestStamp = Number.NEGATIVE_INFINITY;
    const alive: RustLkgReplayParticipant[] = [];
    for (const ref of participants) {
        const participant = ref.deref();
        if (!participant) {
            participants.delete(ref);
            continue;
        }
        alive.push(participant);
        const stamp = participant.lastPassStamp(sessionId);
        if (stamp !== undefined && stamp > latestStamp) {
            latest = participant;
            latestStamp = stamp;
        }
    }
    if (latest) return latest;
    return alive.length === 1 ? alive[0] : undefined;
}

/** True when a live Rust adapter has run a pass for this session in this process. */
export function rustAdapterHasRunSession(sessionId: string): boolean {
    for (const ref of participants) {
        if (ref.deref()?.lastPassStamp(sessionId) !== undefined) return true;
    }
    return false;
}

/** How many adapters are registered and still alive (for tests). */
export function liveRustLkgReplayParticipantCountForTest(): number {
    let count = 0;
    for (const ref of participants) if (ref.deref()) count += 1;
    return count;
}

/**
 * Record that the wrapper just served the LKG slot for this session on
 * `participant` (the wrapper's Rust adapter). Synchronous, so the adapter's next
 * pass sees the freeze with no pending signal in between. A no-op without an
 * adapter (TypeScript mode).
 */
export function noteExternalLkgReplay(
    participant: RustLkgReplayParticipant | undefined,
    sessionId: string,
    inputCount: number,
): void {
    if (!participant) return;
    participant.enterFreezeFromExternalServe(sessionId, inputCount);
    sessionLog(sessionId, "lkg_external_replay_froze_rust_adapter");
}

export function resetRustLkgReplayParticipantsForTest(): void {
    participants.clear();
}
