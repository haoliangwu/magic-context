import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { CTX_NOTE_LIGHT_DESCRIPTION } from "../light-descriptions";
import { CTX_NOTE_DESCRIPTION } from "./constants";

const NOTE_IDS_DESCRIPTION =
    "Note ids: exactly one for 'update', one to fifty for 'dismiss'. Ignored by 'write' and 'read'.";

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
    it("keeps the single id field byte-identical across TS, Pi, and Rust", () => {
        for (const source of [pluginSchemaSource, piSchemaSource, rustSchemaSource]) {
            expect(source).toContain(NOTE_IDS_DESCRIPTION);
        }
        expect(pluginSchemaSource).toContain(".array(tool.schema.number().int().min(1))");
        expect(pluginSchemaSource).toContain(".max(50)");
        expect(piSchemaSource).toContain(
            "Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER })",
        );
        expect(piSchemaSource).toContain("maxItems: 50");
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
