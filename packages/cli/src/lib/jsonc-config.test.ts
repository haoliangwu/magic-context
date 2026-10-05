import { describe, expect, it } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestTempDirFromPath } from "../../../plugin/src/shared/test-temp-dir";

import { readJsoncConfig } from "./jsonc-config";

describe("readJsoncConfig prototype-pollution hardening", () => {
    it("refuses dangerous keys recursively before config mutation", () => {
        const directory = createTestTempDirFromPath(join(tmpdir(), "mc-cli-jsonc-"));
        const path = join(directory, "config.jsonc");
        writeFileSync(
            path,
            `{
                "nested": { "prototype": { "hidden": true } },
                "items": [{ "__proto__": { "plugin": ["attacker"] } }]
            }`,
        );

        try {
            const result = readJsoncConfig(path);
            expect(result.kind).toBe("parse-error");
            if (result.kind === "parse-error") {
                expect(result.error.message).toContain("prototype-pollution");
            }
        } finally {
            rmSync(directory, { recursive: true, force: true });
        }
    });
});
