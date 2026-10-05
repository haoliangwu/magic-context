#!/usr/bin/env bun
/**
 * Generate the production mural glyph atlas from pxpipe's real Spleen 5x8
 * OpenType bitmap font. The renderer imports only the generated module; this
 * script and the local pxpipe checkout are dev-time inputs.
 *
 * Run with:
 *   bun packages/plugin/scripts/generate-mural-font.ts
 *
 * Set MURAL_SPLEEN_FONT to override the default pxpipe asset path.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const outputPath = resolve(here, "../src/features/magic-context/mural/mural-font.generated.ts");
const defaultFontPaths = [
    resolve(here, "../../../../../../OSS/pxpipe/assets/Spleen-5x8.otb"),
    "/Users/ufukaltinok/Work/OSS/pxpipe/assets/Spleen-5x8.otb",
];
const fontPath =
    process.env.MURAL_SPLEEN_FONT ??
    defaultFontPaths.find((candidate) => existsSync(candidate)) ??
    defaultFontPaths[defaultFontPaths.length - 1]!;

interface FontTable {
    offset: number;
}

interface FontGlyph {
    rows: number[];
    width: number;
    advance: number;
}

interface BitmapStrike {
    firstGlyph: number;
    imageDataOffset: number;
    imageSize: number;
}

const fontBytes = new Uint8Array(readFileSync(fontPath));
const fontView = new DataView(fontBytes.buffer, fontBytes.byteOffset, fontBytes.byteLength);

function u16(offset: number): number {
    return fontView.getUint16(offset, false);
}

function i16(offset: number): number {
    return fontView.getInt16(offset, false);
}

function u32(offset: number): number {
    return fontView.getUint32(offset, false);
}

function tag(offset: number): string {
    return String.fromCharCode(
        fontBytes[offset]!,
        fontBytes[offset + 1]!,
        fontBytes[offset + 2]!,
        fontBytes[offset + 3]!,
    );
}

function findTable(name: string): FontTable {
    const tableCount = u16(4);
    for (let index = 0; index < tableCount; index++) {
        const record = 12 + index * 16;
        if (tag(record) === name) {
            return { offset: u32(record + 8) };
        }
    }
    throw new Error(`generate-mural-font: font is missing the ${name} table`);
}

function parseCmap(): (codepoint: number) => number | null {
    const cmap = findTable("cmap");
    const numSubtables = u16(cmap.offset + 2);
    let format4Offset: number | undefined;
    for (let index = 0; index < numSubtables; index++) {
        const record = cmap.offset + 4 + index * 8;
        const subtableOffset = cmap.offset + u32(record + 4);
        if (u16(subtableOffset) === 4) {
            format4Offset = subtableOffset;
            break;
        }
    }
    if (format4Offset === undefined) {
        throw new Error("generate-mural-font: Spleen font has no format-4 cmap");
    }

    const segmentCount = u16(format4Offset + 6) / 2;
    const endCodes = format4Offset + 14;
    const startCodes = endCodes + segmentCount * 2 + 2;
    const idDeltas = startCodes + segmentCount * 2;
    const idRangeOffsets = idDeltas + segmentCount * 2;

    return (codepoint: number): number | null => {
        if (codepoint < 0 || codepoint > 0xffff) return null;
        for (let segment = 0; segment < segmentCount; segment++) {
            const end = u16(endCodes + segment * 2);
            if (codepoint > end) continue;
            const start = u16(startCodes + segment * 2);
            if (codepoint < start) return null;
            const delta = i16(idDeltas + segment * 2);
            const rangeOffsetAddress = idRangeOffsets + segment * 2;
            const rangeOffset = u16(rangeOffsetAddress);
            if (rangeOffset === 0) return (codepoint + delta) & 0xffff;
            const glyphAddress = rangeOffsetAddress + rangeOffset + (codepoint - start) * 2;
            const glyphId = u16(glyphAddress);
            return glyphId === 0 ? null : (glyphId + delta) & 0xffff;
        }
        return null;
    };
}

function parseBitmapStrike(): BitmapStrike {
    const eblc = findTable("EBLC");
    const strikeCount = u32(eblc.offset + 4);
    for (let strike = 0; strike < strikeCount; strike++) {
        const sizeTable = eblc.offset + 8 + strike * 48;
        const ppemX = fontBytes[sizeTable + 44];
        const ppemY = fontBytes[sizeTable + 45];
        if (ppemX !== 8 || ppemY !== 8) continue;

        const subtableArray = eblc.offset + u32(sizeTable);
        const subtableCount = u32(sizeTable + 8);
        for (let index = 0; index < subtableCount; index++) {
            const arrayEntry = subtableArray + index * 8;
            const firstGlyph = u16(arrayEntry);
            const lastGlyph = u16(arrayEntry + 2);
            const subtable = subtableArray + u32(arrayEntry + 4);
            const indexFormat = u16(subtable);
            const imageFormat = u16(subtable + 2);
            if (indexFormat !== 2 || imageFormat !== 1) continue;
            const imageSize = u32(subtable + 8);
            if (imageSize < 5 || lastGlyph < firstGlyph) {
                throw new Error("generate-mural-font: invalid Spleen bitmap strike");
            }
            return {
                firstGlyph,
                imageDataOffset: u32(subtable + 4),
                imageSize,
            };
        }
    }
    throw new Error("generate-mural-font: Spleen font has no 8px format-1 bitmap strike");
}

const cmap = parseCmap();
const strike = parseBitmapStrike();
const ebdt = findTable("EBDT");

function readGlyph(codepoint: number): FontGlyph {
    const glyphId = cmap(codepoint);
    if (glyphId === null) {
        throw new Error(`generate-mural-font: Spleen has no glyph for U+${codepoint.toString(16)}`);
    }
    const glyphOffset =
        ebdt.offset + strike.imageDataOffset + (glyphId - strike.firstGlyph) * strike.imageSize;
    const height = fontBytes[glyphOffset]!;
    const width = fontBytes[glyphOffset + 1]!;
    const advance = fontBytes[glyphOffset + 4]!;
    if (height !== 8 || width === 0 || advance === 0) {
        throw new Error(
            `generate-mural-font: unexpected Spleen glyph metrics for U+${codepoint.toString(16)}: ` +
                `${width}x${height}, advance ${advance}`,
        );
    }
    const rowBytes = Math.ceil(width / 8);
    const rows = Array.from({ length: height }, (_, row) => {
        let bits = 0;
        for (let column = 0; column < width; column++) {
            const byte = fontBytes[glyphOffset + 5 + row * rowBytes + Math.floor(column / 8)]!;
            if ((byte & (0x80 >> (column % 8))) !== 0) bits |= 1 << (width - column - 1);
        }
        return bits;
    });
    return { rows, width, advance };
}

// The Spleen OTB supplies the printable ASCII glyphs and U+2500. These marks
// are the small companion symbols used by mural cues; Spleen intentionally does
// not map the rest of them, so their fixed patterns are explicit rather than a
// random or character-seeded fallback.
const cueMarkPatterns: Record<string, FontGlyph> = {
    "→": { rows: [0, 4, 2, 31, 2, 4, 0, 0], width: 5, advance: 5 },
    "←": { rows: [0, 4, 8, 31, 8, 4, 0, 0], width: 5, advance: 5 },
    "⊘": { rows: [14, 17, 19, 21, 25, 17, 14, 0], width: 5, advance: 5 },
    "∵": { rows: [0, 10, 0, 0, 4, 0, 0, 0], width: 5, advance: 5 },
    "≺": { rows: [0, 2, 4, 8, 4, 2, 0, 0], width: 5, advance: 5 },
    "≻": { rows: [0, 8, 4, 2, 4, 8, 0, 0], width: 5, advance: 5 },
    "∅": { rows: [0, 2, 14, 22, 26, 28, 8, 0], width: 5, advance: 5 },
    "∀": { rows: [17, 17, 17, 31, 10, 10, 4, 0], width: 5, advance: 5 },
    "•": { rows: [0, 0, 4, 14, 14, 4, 0, 0], width: 5, advance: 5 },
    "▰": { rows: [31, 31, 31, 31, 31, 31, 31, 31], width: 5, advance: 5 },
    "—": { rows: [0, 0, 0, 0, 31, 31, 0, 0], width: 5, advance: 5 },
};

const glyphs: Record<string, FontGlyph> = {};
for (let codepoint = 0x20; codepoint <= 0x7e; codepoint++) {
    glyphs[String.fromCodePoint(codepoint)] = readGlyph(codepoint);
}
const boxDrawingHorizontal = String.fromCodePoint(0x2500);
glyphs[boxDrawingHorizontal] = readGlyph(0x2500);
for (const [character, glyph] of Object.entries(cueMarkPatterns)) glyphs[character] = glyph;

const requiredMarks = ["→", "←", "⊘", "∵", "≺", "≻", "∅", "∀", "•", "▰", "─", "—"];
for (const character of requiredMarks) {
    if (!glyphs[character]) throw new Error(`generate-mural-font: missing required cue mark ${character}`);
}

const replacementGlyph: FontGlyph = {
    rows: [31, 17, 21, 17, 21, 17, 31, 0],
    width: 5,
    advance: 5,
};
const entries = Object.entries(glyphs).sort(([left], [right]) => left.codePointAt(0)! - right.codePointAt(0)!);
const cellWidth = Math.max(...Object.values(glyphs).map((glyph) => glyph.advance));
const cellHeight = Math.max(...Object.values(glyphs).map((glyph) => glyph.rows.length));
const linePitch = cellHeight + 1;

const licenseHeader = `// AUTO-GENERATED by scripts/generate-mural-font.ts from pxpipe/assets/Spleen-5x8.otb
// DO NOT EDIT BY HAND. Regenerate: bun packages/plugin/scripts/generate-mural-font.ts
//
// Spleen 5x8 bitmap data is Copyright (c) 2018-2026, Frederic Cambus.
// All rights reserved. Spleen is distributed under the BSD-2-Clause license:
//
//   Redistribution and use in source and binary forms, with or without
//   modification, are permitted provided that the following conditions are met:
//   * Redistributions of source code must retain the above copyright notice,
//     this list of conditions and the following disclaimer.
//   * Redistributions in binary form must reproduce the above copyright notice,
//     this list of conditions and the following disclaimer in the documentation
//     and/or other materials provided with the distribution.
//   THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
//   AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
//   IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE
//   ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE
//   LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR
//   CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF
//   SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS
//   INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN
//   CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE)
//   ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE
//   POSSIBILITY OF SUCH DAMAGE.
//
// The Spleen font supplies printable ASCII and U+2500; the additional mural
// cue marks use deterministic 5x8 companion patterns because they are not
// mapped by the Spleen 5x8 OTB.
//
// Source: pxpipe/assets/Spleen-5x8.otb

`;
const serializedEntries = entries
    .map(
        ([character, glyph]) =>
            `    ${JSON.stringify(character)}: { rows: [${glyph.rows.join(", ")}], width: ${glyph.width}, advance: ${glyph.advance} },`,
    )
    .join("\n");
const output = `${licenseHeader}export interface MuralFontGlyph {
    readonly rows: readonly number[];
    readonly width: number;
    readonly advance: number;
}

export const MURAL_FONT_CELL_WIDTH = ${cellWidth};
export const MURAL_FONT_CELL_HEIGHT = ${cellHeight};
export const MURAL_FONT_LINE_PITCH = ${linePitch};
export const MURAL_FONT_GLYPHS: Readonly<Record<string, MuralFontGlyph>> = {
${serializedEntries}
};

/** Visible, deterministic replacement for characters outside the generated atlas. */
export const MURAL_FONT_REPLACEMENT_GLYPH: MuralFontGlyph = {
    rows: [${replacementGlyph.rows.join(", ")}],
    width: ${replacementGlyph.width},
    advance: ${replacementGlyph.advance},
};
`;

writeFileSync(outputPath, output, "utf8");
console.log(
    `generate-mural-font: emitted ${entries.length} glyphs (${cellWidth}x${cellHeight}, pitch ${linePitch}) → ${outputPath}`,
);
