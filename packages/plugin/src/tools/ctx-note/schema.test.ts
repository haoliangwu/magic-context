import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { CTX_NOTE_LIGHT_DESCRIPTION } from "../light-descriptions";
import { CTX_NOTE_DESCRIPTION } from "./constants";

const NOTE_IDS_DESCRIPTION =
    "Note ids: one for update, 1–50 for dismiss, or 1–50 to read those notes in full. Write and a plain read take an empty list.";
// ck-mc keeps the previous contract until the Claude Code gateway owner picks
// this up on the release train: at least one id required, and the
// write-ignores wording.
const RUST_NOTE_IDS_DESCRIPTION =
    "Note ids: one for update, 1–50 for dismiss or read (read returns full bodies). Ignored by write.";

const pluginSchemaSource = readFileSync(resolve(import.meta.dir, "tools.ts"), "utf8");
const piSchemaSource = readFileSync(
    resolve(import.meta.dir, "../../../../pi-plugin/src/tools/ctx-note.ts"),
    "utf8",
);
const rustSchemaSource = readFileSync(
    resolve(import.meta.dir, "../../../../../crates/mc-module/src/lib.rs"),
    "utf8",
);

describe("ctx_note note_ids schema parity", () => {
    it("keeps the single id field byte-identical across TS and Pi, with Rust following on the release train", () => {
        for (const source of [pluginSchemaSource, piSchemaSource]) {
            expect(source).toContain(NOTE_IDS_DESCRIPTION);
        }
        expect(pluginSchemaSource).toContain(".array(tool.schema.number().int().min(1))");
        expect(pluginSchemaSource).toContain(".max(50)");
        expect(piSchemaSource).toContain(
            "Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER })",
        );
        expect(piSchemaSource).toContain("maxItems: 50");
        expect(rustSchemaSource).toContain(RUST_NOTE_IDS_DESCRIPTION);
        expect(rustSchemaSource).toContain(
            '"minItems": 1, "maxItems": 50, "items": { "type": "integer", "minimum": 1, "maximum": 9007199254740991_i64 }',
        );
    });

    it("declares no note_id scalar on any lane", () => {
        // A second id field is what made required-all tool surfaces fail every
        // call with filler in both (issue 460); the schema must not grow it back.
        for (const source of [pluginSchemaSource, piSchemaSource]) {
            expect(source).not.toMatch(/note_id\??:\s/);
        }
        expect(rustSchemaSource).not.toContain('"note_id": {');
    });

    it("mentions the id field in each description preset", () => {
        expect(CTX_NOTE_DESCRIPTION.match(/\bnote_ids\b/g)?.length ?? 0).toBeGreaterThan(0);
        expect(CTX_NOTE_LIGHT_DESCRIPTION.match(/\bnote_ids\b/g)?.length ?? 0).toBeGreaterThan(0);
        expect(CTX_NOTE_DESCRIPTION).not.toMatch(/\bnote_id\b/);
        expect(CTX_NOTE_LIGHT_DESCRIPTION).not.toMatch(/\bnote_id\b/);
    });
});
