import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { openExternal } from "./open-external";

describe("external links", () => {
  it("refuses URLs outside the approved docs origin and path", async () => {
    await expect(openExternal("https://github.com/cortexkit/magic-context")).rejects.toThrow(
      "External URL is not allowed",
    );
    await expect(openExternal("https://docs.cortexkit.io/other/page")).rejects.toThrow(
      "External URL is not allowed",
    );
    await expect(
      openExternal("http://docs.cortexkit.io/magic-context/reference/configuration/"),
    ).rejects.toThrow("External URL is not allowed");
  });

  it("limits opener permission to docs pages and grants no shell permissions", () => {
    const capabilityPath = resolve(import.meta.dir, "../../src-tauri/capabilities/default.json");
    const capability = JSON.parse(readFileSync(capabilityPath, "utf8")) as {
      permissions: Array<string | { identifier: string; allow?: Array<{ url?: string }> }>;
    };
    const opener = capability.permissions.find(
      (permission) =>
        typeof permission !== "string" && permission.identifier === "opener:allow-open-url",
    );

    expect(opener).toEqual({
      identifier: "opener:allow-open-url",
      allow: [{ url: "https://docs.cortexkit.io/magic-context/*" }],
    });
    expect(
      capability.permissions.some((permission) =>
        typeof permission === "string"
          ? permission.startsWith("shell:")
          : permission.identifier.startsWith("shell:"),
      ),
    ).toBe(false);
  });
});
