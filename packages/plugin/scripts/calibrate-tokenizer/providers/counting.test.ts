import { expect, it, spyOn } from "bun:test";
import { postCountJson } from "./counting";

it("reports known billing classes without echoing arbitrary provider error data", async () => {
    for (const [status, payload, expected] of [
        [429, { error: { type: "exceeded_current_quota_error", message: "DO NOT ECHO" } }, "exceeded_current_quota_error"],
        [429, { error: { code: "1113", message: "DO NOT ECHO" } }, "1113"],
        [402, { error: { code: "billing_not_configured", message: "DO NOT ECHO" } }, "billing_not_configured"],
        [400, { error: { code: "DO NOT ECHO", message: "DO NOT ECHO" } }, "request rejected"],
    ] as const) {
        const mock = spyOn(globalThis, "fetch").mockImplementation((async (_url: string | URL | Request, _init?: RequestInit) => Response.json(payload, { status })) as typeof fetch);
        try {
            await expect(postCountJson("https://example.test/count", {}, {})).rejects.toThrow(`/count HTTP ${status} (${expected})`);
        } finally { mock.mockRestore(); }
    }
});
