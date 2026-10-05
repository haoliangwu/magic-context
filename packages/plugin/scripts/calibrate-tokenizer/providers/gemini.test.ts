import { expect, it, spyOn } from "bun:test";
import { measureGemini } from "./gemini";
import { resolveModelCalibration } from "../../../src/hooks/magic-context/tokenizer-calibration";

it("counts Gemini system and tools inside generateContentRequest with API-key auth", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const mock = spyOn(globalThis, "fetch").mockImplementation((async (url: string | URL | Request, init?: RequestInit) => {
        expect(String(url)).toBe("https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:countTokens");
        const headers = new Headers(init?.headers);
        expect(headers.get("x-goog-api-key")).toBe("test-key");
        expect(headers.has("authorization")).toBe(false);
        const body = JSON.parse(String(init?.body));
        expect(body.contents).toBeUndefined();
        const request = body.generateContentRequest;
        expect(request.model).toBe("models/gemini-3.8-flash");
        bodies.push(request);
        return Response.json({ totalTokens: request.systemInstruction ? 110 : request.tools ? 210 : request.contents[0].parts[0].text === "x" ? 10 : 310 });
    }) as typeof fetch);
    try {
        expect(await measureGemini("gemini-3.8-flash", "test-key", "system", [{ name: "read", input_schema: { type: "object" } }], { docs: "docs" })).toEqual({ method: "countTokens", systemApi: 100, toolsApi: 200, proseApi: 300, sections: { docs: 300 } });
        expect(bodies[2]?.tools).toEqual([{ functionDeclarations: [{ name: "read", parametersJsonSchema: { type: "object" } }] }]);
        expect(mock).toHaveBeenCalledTimes(5);
    } finally { mock.mockRestore(); }
});

it("calibrates only measured public Gemini ids, not unmeasured antigravity routes", () => {
    for (const model of ["gemini-3.8-flash", "gemini-3.7-flash", "gemini-3.1-pro-preview"]) {
        expect(resolveModelCalibration("google", model)).toMatchObject({ systemRatio: 0.961167, toolsRatio: 0.967504, proseRatio: 1.006909 });
    }
    expect(resolveModelCalibration("google", "gemini-2.5-pro").proseRatio).toBe(1);
    expect(resolveModelCalibration("google", "antigravity-gemini-3.8-flash").proseRatio).toBe(1);
});
