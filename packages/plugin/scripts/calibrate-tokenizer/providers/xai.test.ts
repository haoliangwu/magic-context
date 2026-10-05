import { expect, it, spyOn } from "bun:test";
import { measureXai } from "./xai";
import { crossCheck } from "../cross-check";
import { resolveModelCalibration } from "../../../src/hooks/magic-context/tokenizer-calibration";

it("tokenizes exact SYSTEM and serialized chat tool bytes without a fake baseline", async () => {
    const texts: string[] = [];
    const mock = spyOn(globalThis, "fetch").mockImplementation((async (url: string | URL | Request, init?: RequestInit) => {
        expect(String(url)).toBe("https://api.x.ai/v1/tokenize-text");
        const body = JSON.parse(String(init?.body));
        texts.push(body.text);
        expect(Object.keys(body).sort()).toEqual(["model", "text"]);
        return Response.json({ token_ids: [{ token_id: 1 }, { token_id: 2 }] });
    }) as typeof fetch);
    try {
        const result = await measureXai("grok-4-latest", "test-key", "SYSTEM", [{ name: "read", input_schema: { type: "object" } }], { docs: "DOCS", history: "HISTORY" });
        expect(texts).toEqual(["SYSTEM", '[{"type":"function","function":{"name":"read","parameters":{"type":"object"}}}]', "DOCS\n\nHISTORY", "DOCS", "HISTORY"]);
        expect(result.systemApi).toBe(2);
        expect(result.proseApi).toBe(2);
        expect(result.caveat).toContain("unmeasured");
    } finally { mock.mockRestore(); }
});

it("retains the overcount direction for measured Grok ids", () => {
    for (const model of ["grok-4-latest", "grok-code-fast-1"]) {
        expect(resolveModelCalibration("xai", model)).toMatchObject({ systemRatio: 0.817751, toolsRatio: 0.880494, proseRatio: 0.880137 });
        expect(crossCheck("xai", model, 0.817751, 0.880494)?.failed).toBe(false);
        expect(crossCheck("xai", model, 1 / 0.817751, 1 / 0.880494)?.failed).toBe(true);
    }
});
