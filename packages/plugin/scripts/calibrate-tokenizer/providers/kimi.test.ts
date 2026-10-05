import { expect, it, spyOn } from "bun:test";
import { measureKimi } from "./kimi";
import { crossCheck } from "../cross-check";

it("counts Moonshot chat envelopes including function tools", async () => {
    const mock = spyOn(globalThis, "fetch").mockImplementation((async (url: string | URL | Request, init?: RequestInit) => {
        expect(String(url)).toBe("https://api.moonshot.ai/v1/tokenizers/estimate-token-count");
        const body = JSON.parse(String(init?.body));
        expect(body.model).toBe("kimi-k2.6");
        expect(body.max_tokens).toBeUndefined();
        if (body.tools) expect(body.tools).toEqual([{ type: "function", function: { name: "read", description: "Read", parameters: { type: "object" } } }]);
        return Response.json({ data: { total_tokens: body.tools ? 210 : body.messages.length > 1 ? 110 : body.messages[0].content === "x" ? 10 : 310 } });
    }) as typeof fetch);
    try {
        expect(await measureKimi("kimi-k2.6", "test-key", "system", [{ name: "read", description: "Read", input_schema: { type: "object" } }], { docs: "docs" })).toEqual({ method: "tokenizers/estimate-token-count", systemApi: 100, toolsApi: 200, proseApi: 300, sections: { docs: 300 } });
        expect(mock).toHaveBeenCalledTimes(5);
    } finally { mock.mockRestore(); }
});

it("rejects a cross-check drift above five percent in either direction", () => {
    expect(crossCheck("moonshot", "kimi-k2.6", 0.87, 0.86)?.failed).toBe(false);
    expect(crossCheck("moonshot", "kimi-k2.6", 0.87, 0)?.failed).toBe(true);
    expect(crossCheck("moonshot", "kimi-k2.6", 1, 0.86)?.failed).toBe(true);
    expect(crossCheck("anthropic", "claude-opus-4-7", 1.51, 1.57)?.failed).toBe(false);
    expect(crossCheck("unknown", "model", 2, 2)).toBeNull();
});
