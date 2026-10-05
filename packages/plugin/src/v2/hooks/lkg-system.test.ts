import { expect, test } from "bun:test";
import type { LkgSlot } from "../../hooks/magic-context/lkg-slot";
import { V2LkgSystemReplay } from "./lkg-system";

const slot = (): LkgSlot => ({
    jsonPrefix: "[]",
    inputIdSeq: [],
    inputContentDigests: [],
    lastInputMessageId: "u",
    modelKey: "p/m",
    providerKey: "p",
    capturedAt: 1,
});

test("LKG system replay restores detached served bytes only for the same input and slot", () => {
    const replay = new V2LkgSystemReplay();
    const captured = slot();
    const input = [{ type: "text", text: "host" }];
    const served = [{ type: "text", text: "host + managed guidance" }];
    replay.capture("session", captured, input, served);
    served[0].text = "mutated later";
    const target = structuredClone(input);
    expect(replay.restore("session", captured, input, target)).toBe(true);
    expect(target).toEqual([{ type: "text", text: "host + managed guidance" }]);
    target[0].text = "consumer edit";
    expect(replay.restore("session", captured, input, target)).toBe(true);
    expect(target[0].text).toBe("host + managed guidance");
    expect(
        replay.restore(
            "session",
            captured,
            [{ type: "text", text: "different host system" }],
            target,
        ),
    ).toBe(false);
    expect(replay.restore("session", structuredClone(captured), input, target)).toBe(true);
    expect(replay.restore("session", { ...slot(), capturedAt: 2 }, input, target)).toBe(false);
    expect(new V2LkgSystemReplay().restore("session", captured, input, target)).toBe(false);
    expect(replay.restore("session", undefined, input, target)).toBe(false);
});
