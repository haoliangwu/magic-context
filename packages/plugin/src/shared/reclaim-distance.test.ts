import { describe, expect, it } from "bun:test";
import {
    farBehindToolBookmark,
    isReclaimUserTurn,
    type ReclaimDistanceEntry,
} from "./reclaim-distance";

const output = (tag: number, tokens = 1000): ReclaimDistanceEntry => ({
    toolOutputTag: tag,
    tokens,
});
const turn = (): ReclaimDistanceEntry => ({ userTurn: true, tokens: 10 });

describe("reclaim distance", () => {
    it("repeated rebuilds cannot age the current task", () => {
        const entries = [turn(), ...Array.from({ length: 28 }, (_, i) => output(i + 1))];
        for (const count of [2, 3, 5]) {
            let bookmark = 0;
            for (let pass = 0; pass < count + 1; pass++) {
                expect(bookmark).toBe(0);
                bookmark = Math.max(bookmark, farBehindToolBookmark(entries, 200_000));
            }
        }
    });

    it("three newer user turns establish a bookmark, not two", () => {
        const entries = [turn(), output(1), turn(), output(2), turn()];
        expect(farBehindToolBookmark(entries, 200_000)).toBe(0);
        expect(farBehindToolBookmark([...entries, turn()], 200_000)).toBe(1);
    });

    it("single-turn tool loop ages at exactly a quarter of the usable window", () => {
        const entries = [turn(), output(1), output(2, 49_999)];
        expect(farBehindToolBookmark(entries, 200_000)).toBe(0);
        expect(farBehindToolBookmark([...entries, { tokens: 1 }], 200_000)).toBe(1);
        expect(farBehindToolBookmark([turn(), output(1, 100_000)], 200_000)).toBe(0);
    });

    it("multipart outputs never age from their own trailing chunks", () => {
        expect(farBehindToolBookmark([output(1), output(1, 60_000)], 200_000)).toBe(0);
    });

    it("unknown windows disable only token distance", () => {
        expect(farBehindToolBookmark([output(1), output(2, 99_999)], 0)).toBe(0);
        expect(farBehindToolBookmark([output(1), turn(), turn(), turn()], 0)).toBe(1);
    });

    it("excludes synthetic host wakes, MC reminders, heads and result carriers", () => {
        expect(
            isReclaimUserTurn({
                role: "user",
                parts: [
                    {
                        kind: "text",
                        synthetic: true,
                        text: "<system-reminder>Background task finished.</system-reminder>",
                    },
                ],
            }),
        ).toBe(false);
        expect(
            isReclaimUserTurn({
                role: "user",
                parts: [
                    {
                        kind: "text",
                        text: "<system-reminder>Your next step: call ctx_reduce on the outputs you've already used (5).</system-reminder>",
                    },
                ],
            }),
        ).toBe(false);
        expect(
            isReclaimUserTurn({
                role: "user",
                syntheticHead: true,
                parts: [{ kind: "text", text: "history" }],
            }),
        ).toBe(false);
        expect(
            isReclaimUserTurn({ role: "user", parts: [{ kind: "tool_result", text: "output" }] }),
        ).toBe(false);
        expect(
            isReclaimUserTurn({
                role: "user",
                parts: [
                    { kind: "tool_result", text: "output" },
                    { kind: "text", text: "continue" },
                ],
            }),
        ).toBe(true);
    });

    it("counts an authored part even after synthetic or ignored parts", () => {
        for (const provenance of [{ synthetic: true }, { ignored: true }]) {
            expect(
                isReclaimUserTurn({ role: "user", parts: [{ kind: "image", ...provenance }] }),
            ).toBe(false);
            expect(
                isReclaimUserTurn({
                    role: "user",
                    parts: [{ kind: "text", text: "notice", ...provenance }, { kind: "image" }],
                }),
            ).toBe(true);
        }
    });

    it("a young lower-tag result holds back distant higher tags", () => {
        expect(farBehindToolBookmark([output(2), output(3, 50_000), output(1)], 200_000)).toBe(0);
        expect(farBehindToolBookmark([output(1), output(3, 50_000), output(2)], 200_000)).toBe(1);
    });
});
