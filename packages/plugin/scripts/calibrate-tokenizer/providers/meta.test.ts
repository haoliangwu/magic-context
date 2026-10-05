import { expect, it, spyOn } from "bun:test";
import { measureMeta, META_COUNT_CAVEAT } from "./meta";

it("counts Meta preflight requests and preserves the cumulative-usage caveat", async () => {
    const mock = spyOn(globalThis, "fetch").mockImplementation((async (url: string | URL | Request, init?: RequestInit) => {
        expect(String(url)).toBe("https://api.meta.ai/v1/responses/input_tokens");
        expect(new Headers(init?.headers).get("authorization")).toBe("Bearer test-key");
        const body = JSON.parse(String(init?.body));
        if (body.tools) expect(body.tools).toEqual([{ type: "function", name: "read", parameters: { type: "object" } }]);
        return Response.json({ input_tokens: body.instructions ? 110 : body.tools ? 210 : body.input[0].content === "x" ? 10 : 310 });
    }) as typeof fetch);
    try {
        expect(await measureMeta("muse-spark-1.3", "test-key", "system", [{ name: "read", input_schema: { type: "object" } }], { docs: "docs" })).toEqual({ method: "input_tokens", systemApi: 100, toolsApi: 200, proseApi: 300, sections: { docs: 300 }, caveat: META_COUNT_CAVEAT });
        expect(mock).toHaveBeenCalledTimes(5);
    } finally { mock.mockRestore(); }
});

it("reports unavailable Meta counting without attempting paid inference", async () => {
    const mock = spyOn(globalThis, "fetch").mockImplementation((async (_url: string | URL | Request, _init?: RequestInit) => new Response("private response omitted", { status: 402 })) as typeof fetch);
    try {
        await expect(measureMeta("muse-spark-1.3", "test-key", "system", [], { docs: "docs" })).rejects.toThrow("HTTP 402");
        expect(mock).toHaveBeenCalledTimes(1);
    } finally { mock.mockRestore(); }
});
