import { expect, it, spyOn } from "bun:test";
import { measureOpenAI } from "./openai";
import { requireCount } from "./counting";

it("counts Responses instructions, function tools, and prose with a shared baseline", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const mock = spyOn(globalThis, "fetch").mockImplementation((async (url: string | URL | Request, init?: RequestInit) => {
        expect(String(url)).toBe("https://api.openai.com/v1/responses/input_tokens");
        expect(new Headers(init?.headers).get("authorization")).toBe("Bearer test-key");
        const body = JSON.parse(String(init?.body));
        bodies.push(body);
        return Response.json({ input_tokens: body.instructions ? 110 : body.tools ? 210 : body.input[0].content === "x" ? 10 : 310 });
    }) as typeof fetch);
    try {
        const result = await measureOpenAI("gpt-6-astra", "test-key", "system", [{ name: "read", description: "Read", input_schema: { type: "object" } }], { docs: "docs", history: "history", memory: "memory" });
        expect(result).toEqual({ method: "responses/input_tokens", systemApi: 100, toolsApi: 200, proseApi: 300, sections: { docs: 300, history: 300, memory: 300 } });
        expect(bodies[2]?.tools).toEqual([{ type: "function", name: "read", description: "Read", parameters: { type: "object" } }]);
        expect(bodies).toHaveLength(7);
    } finally { mock.mockRestore(); }
});

it("rejects invalid counts instead of treating them as a measured zero", () => {
    for (const value of [undefined, null, "3", NaN, Infinity, -1]) expect(() => requireCount(value)).toThrow();
    expect(requireCount(0)).toBe(0);
});
