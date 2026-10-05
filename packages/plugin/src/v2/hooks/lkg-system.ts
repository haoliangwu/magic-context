import { createHash } from "node:crypto";
import type { LkgSlot } from "../../hooks/magic-context/lkg-slot";
import { BoundedSessionMap } from "../../shared/bounded-session-map";
import type { SessionContext } from "./types";

type System = SessionContext["system"];
function identity(slot: LkgSlot): string {
    return createHash("sha256")
        .update(
            JSON.stringify({
                capturedAt: slot.capturedAt,
                captureSequence: slot.captureSequence,
                rowVersion: slot.rowVersion,
                modelKey: slot.modelKey,
                providerKey: slot.providerKey,
                inputIdSeq: slot.inputIdSeq,
                inputContentDigests: slot.inputContentDigests,
            }),
        )
        .update(slot.jsonPrefix)
        .digest("hex");
}

/** A message snapshot may replay only with the system that was served alongside it. */
export class V2LkgSystemReplay {
    private readonly systems = new BoundedSessionMap<{
        slot: string;
        input: string;
        served: System;
    }>(1000);

    capture(sessionId: string, slot: LkgSlot, input: System, served: System): void {
        this.systems.set(sessionId, {
            slot: identity(slot),
            input: JSON.stringify(input),
            served: structuredClone(served),
        });
    }

    restore(sessionId: string, slot: LkgSlot | undefined, input: System, target: System): boolean {
        const saved = this.systems.get(sessionId);
        // Slot reads return copies. Match their content identity, not object identity.
        // After restart, the system served with the snapshot is unknown. A
        // successful transform must capture the system and messages together again.
        if (
            !slot ||
            !saved ||
            saved.slot !== identity(slot) ||
            saved.input !== JSON.stringify(input)
        )
            return false;
        target.splice(0, target.length, ...structuredClone(saved.served));
        return true;
    }
}
