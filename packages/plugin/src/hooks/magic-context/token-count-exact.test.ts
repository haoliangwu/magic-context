/// <reference types="bun-types" />

import { describe, expect, it } from "bun:test";
import { createRequire } from "node:module";
import { estimateTokens } from "./read-session-formatting";
import { encodeTokensExactly } from "./token-count-exact";

const requireFromHere = createRequire(import.meta.url);

function claudeTokenizer(): { encode: (text: string, special: string) => number[] } {
    const module = requireFromHere("ai-tokenizer") as {
        default?: new (encoding: unknown) => never;
        Tokenizer?: new (encoding: unknown) => never;
    };
    const Tokenizer = (module.default ?? module.Tokenizer) as new (
        encoding: unknown,
    ) => ReturnType<typeof claudeTokenizer>;
    return new Tokenizer(requireFromHere("ai-tokenizer/encoding/claude"));
}

function rng(seed: number): () => number {
    let state = seed >>> 0 || 1;
    return () => {
        state ^= state << 13;
        state >>>= 0;
        state ^= state >>> 17;
        state ^= state << 5;
        state >>>= 0;
        return state / 0x100000000;
    };
}

// Character classes the tokenizer's pattern keeps together in one piece, plus
// multi-byte and invisible characters whose byte slices are not valid UTF-8 on
// their own, and a BOM, which the library's decoder drops.
const ALPHABETS = [
    "abcdefghijklmnopqrstuvwxyz",
    "      \t",
    "-=_*#~.",
    "0123456789",
    "日本語中文字符",
    "😀🚀✨🧪",
    "ÄÖÜäöüßéè",
    "\ufeff\u200b",
    "aaaa",
    "ab",
    "\n",
];

describe("exact token counts", () => {
    it("gives the library's tokens for randomized texts with long unbroken runs", () => {
        const tokenizer = claudeTokenizer();
        const random = rng(653);
        let longPieces = 0;
        for (let sample = 0; sample < 300; sample += 1) {
            let text = "";
            for (let run = 1 + Math.floor(random() * 4); run > 0; run -= 1) {
                const alphabet = [
                    ...(ALPHABETS[Math.floor(random() * ALPHABETS.length)] as string),
                ];
                const length = Math.floor(random() * (random() < 0.3 ? 3_000 : 300));
                if (length > 256) longPieces += 1;
                for (let index = 0; index < length; index += 1) {
                    text += alphabet[Math.floor(random() * alphabet.length)];
                }
                if (random() < 0.5) text += " word <EOT> ";
            }
            expect(encodeTokensExactly(tokenizer, text)).toEqual(tokenizer.encode(text, "all"));
        }
        // Long pieces (merged with the heap) were among those compared.
        expect(longPieces).toBeGreaterThan(20);
    });

    it("gives the library's tokens across merge-cache generations", () => {
        // About 200,000 distinct pieces: more than two cache generations.
        const tokenizer = claudeTokenizer();
        const random = rng(29);
        const bytes = Buffer.alloc(450_000);
        for (let index = 0; index < bytes.length; index += 1) {
            bytes[index] = Math.floor(random() * 256);
        }
        const text = bytes.toString("base64");
        expect(encodeTokensExactly(tokenizer, text)).toEqual(tokenizer.encode(text, "all"));
        expect(encodeTokensExactly(tokenizer, text)).toEqual(tokenizer.encode(text, "all"));
    });

    it("counts 3 MB of base64 in time linear in its length", () => {
        // Nearly every base64 piece is new, so the library's merge cache evicts on
        // almost every piece once full; its eviction walks past earlier deletions
        // and 4 MB took about 17 s. The check compares scaling rather than wall
        // time, because a shared CI runner is several times slower than a laptop:
        // ten times the input costs about 11x here, while the library's own path
        // costs about 70x on the same pair.
        const base64Image = (length: number, seed: number): string => {
            const random = rng(seed);
            const bytes = Buffer.alloc(length);
            for (let index = 0; index < bytes.length; index += 1) {
                bytes[index] = Math.floor(random() * 256);
            }
            return `data:image/png;base64,${bytes.toString("base64")}`;
        };
        const timed = (text: string): number => {
            const started = performance.now();
            estimateTokens(text);
            return performance.now() - started;
        };
        // Warm the counter so the small sample doesn't carry first-call setup.
        estimateTokens(base64Image(24_000, 5));
        const small = Math.min(timed(base64Image(240_000, 3)), timed(base64Image(240_000, 7)));
        const large = base64Image(2_400_000, 11);
        expect(estimateTokens(large)).toBeGreaterThan(1_000_000);
        expect(timed(large) / small).toBeLessThan(30);
    }, 60_000);

    it("counts a 300,000-character unbroken run promptly", () => {
        // The library's merge takes about 0.75 s at 40,000 characters and grows
        // with the square of the length, so this run would take about 40 s.
        let text = "";
        const random = rng(7);
        while (text.length < 300_000) text += String.fromCharCode(97 + Math.floor(random() * 26));
        const started = performance.now();
        expect(estimateTokens(text)).toBeGreaterThan(100_000);
        expect(performance.now() - started).toBeLessThan(5_000);
    }, 20_000);
});
