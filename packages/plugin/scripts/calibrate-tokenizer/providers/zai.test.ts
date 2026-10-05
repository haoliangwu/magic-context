import { expect, it, spyOn } from "bun:test";
import { measureZai } from "./zai";
import { crossCheck } from "../cross-check";

it("reads Z.ai prompt_tokens and sends chat-shaped probes", async () => {
    const mock = spyOn(globalThis, "fetch").mockImplementation((async (url: string | URL | Request, init?: RequestInit) => {
        expect(String(url)).toBe("https://api.z.ai/api/paas/v4/tokenizer");
        expect(new Headers(init?.headers).get("authorization")).toBe("Bearer test-key");
        const body = JSON.parse(String(init?.body));
        if (body.tools) expect(body.tools[0].function.parameters).toEqual({ type: "object" });
        return Response.json({ usage: { prompt_tokens: body.tools ? 210 : body.messages.length > 1 ? 110 : body.messages[0].content === "x" ? 10 : 310 } });
    }) as typeof fetch);
    try {
        expect(await measureZai("glm-5", "test-key", "system", [{ name: "read", input_schema: { type: "object" } }], { docs: "docs" })).toEqual({ method: "paas/v4/tokenizer", systemApi: 100, toolsApi: 200, proseApi: 300, sections: { docs: 300 } });
        expect(mock).toHaveBeenCalledTimes(5);
    } finally { mock.mockRestore(); }
});

it("cross-checks GLM generations against their existing usage reference", () => {
    expect(crossCheck("zai", "glm-5", 1, 1.06)?.failed).toBe(false);
    expect(crossCheck("zai", "glm-5.1", 1, 1.06)?.failed).toBe(false);
    expect(crossCheck("zai", "glm-4.7", 1, 1.09)?.failed).toBe(false);
    expect(crossCheck("zai", "glm-5.1", 1, 0)?.failed).toBe(true);
});
