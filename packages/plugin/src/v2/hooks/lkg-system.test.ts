import { expect, test } from "bun:test";
import type { LkgSlot } from "../../hooks/magic-context/lkg-slot";
import { V2LkgSystemReplay } from "./lkg-system";
import type { V2Message } from "./types";

const slot = (): LkgSlot => ({
    jsonPrefix: "[]",
    inputIdSeq: [],
    inputContentDigests: [],
    lastInputMessageId: "u",
    modelKey: "p/m",
    providerKey: "p",
    capturedAt: 1,
});

const checkpoint = (summary: string): V2Message => ({
    id: "cut",
    role: "user",
    content: [{ type: "text", text: `<summary>\n${summary}\n</summary>` }],
});

test("LKG system replay restores detached served bytes only for the same input and slot", () => {
    const replay = new V2LkgSystemReplay();
    const captured = slot();
    const system = [{ type: "text", text: "host" }];
    const input = { system, checkpoint: null };
    const served = [{ type: "text", text: "host + managed guidance" }];
    replay.capture("session", captured, input, served, null);
    served[0].text = "mutated later";
    const target = structuredClone(system);
    expect(replay.restore("session", captured, input, target)).toEqual({ head: null });
    expect(target).toEqual([{ type: "text", text: "host + managed guidance" }]);
    target[0].text = "consumer edit";
    expect(replay.restore("session", captured, input, target)).toBeDefined();
    expect(target[0].text).toBe("host + managed guidance");
    expect(
        replay.restore(
            "session",
            captured,
            { system: [{ type: "text", text: "different host system" }], checkpoint: null },
            target,
        ),
    ).toBeUndefined();
    expect(replay.restore("session", structuredClone(captured), input, target)).toBeDefined();
    expect(replay.restore("session", { ...slot(), capturedAt: 2 }, input, target)).toBeUndefined();
    expect(new V2LkgSystemReplay().restore("session", captured, input, target)).toBeUndefined();
    expect(replay.restore("session", undefined, input, target)).toBeUndefined();
});

test("LKG system replay pairs the checkpoint head with the checkpoint the host sent", () => {
    const replay = new V2LkgSystemReplay();
    const captured = slot();
    const system = [{ type: "text", text: "host" }];
    const head = { checkpoint: checkpoint("submitted"), submitted: "submitted" };
    replay.capture(
        "session",
        captured,
        { system, checkpoint: checkpoint("host summary") },
        system,
        head,
    );
    // The saved head is detached from the caller's object.
    head.checkpoint.content[0]!.text = "mutated later";
    const target: typeof system = [];
    const restored = replay.restore(
        "session",
        captured,
        { system, checkpoint: checkpoint("host summary") },
        target,
    );
    expect(restored?.head?.checkpoint).toEqual(checkpoint("submitted"));
    expect(restored?.head?.submitted).toBe("submitted");
    // A re-rendered checkpoint, a vanished one, or a new one is a different input.
    for (const other of [checkpoint("re-rendered"), null])
        expect(
            replay.restore("session", captured, { system, checkpoint: other }, target),
        ).toBeUndefined();
    replay.capture("session", captured, { system, checkpoint: null }, system, null);
    expect(
        replay.restore("session", captured, { system, checkpoint: checkpoint("new") }, target),
    ).toBeUndefined();
});
