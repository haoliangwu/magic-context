import { expect, test } from "bun:test";
import { hasRequiredSessionAPI, OPENCODE2_SESSION_API_NOTICE } from "./session-api-gate";

test("OpenCode 2 requires remove and compact capabilities, never a version string", () => {
    expect(hasRequiredSessionAPI({ compact() {} })).toBe(false);
    expect(hasRequiredSessionAPI({ remove() {} })).toBe(false);
    expect(hasRequiredSessionAPI({ remove: "function", compact() {} })).toBe(false);
    expect(hasRequiredSessionAPI({ remove() {}, compact() {}, version: "0.0.0-dev" })).toBe(true);
    expect(OPENCODE2_SESSION_API_NOTICE).toContain("OpenCode 2.0.22");
});
