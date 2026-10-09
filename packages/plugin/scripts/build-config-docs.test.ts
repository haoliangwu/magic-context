import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";

describe("configuration reference docs", () => {
    const docsPath = path.resolve(
        import.meta.dir,
        "..",
        "..",
        "docs",
        "src",
        "content",
        "docs",
        "reference",
        "configuration.md",
    );

    test("committed configuration.md matches generator output (run `bun packages/plugin/scripts/build-config-docs.ts` if this fails)", async () => {
        const { buildConfigDocs } = await import("./build-config-docs");
        const committed = fs.readFileSync(docsPath, "utf-8");
        const regenerated = buildConfigDocs();
        expect(committed).toBe(regenerated);
    });
});

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe as describeRender, expect as expectRender, test as testRender } from "bun:test";

describeRender("generated reference table cell escaping", () => {
    testRender("union-typed rows escape the pipe exactly once so the description stays in column four", () => {
        const md = readFileSync(
            join(import.meta.dir, "../../docs/src/content/docs/reference/configuration.md"),
            "utf8",
        );
        // A double backslash before a pipe renders as a literal backslash plus a
        // real cell separator and shifts every later cell one column right.
        expectRender(md).not.toContain("\\\\|");
        const cacheTtlRow = md.split("\n").find((line) => line.startsWith("| `cache_ttl` "));
        expectRender(cacheTtlRow).toBeDefined();
        // Split on unescaped pipes only: 4 data cells + the two outer empties.
        const cells = (cacheTtlRow as string).split(/(?<!\\)\|/);
        expectRender(cells).toHaveLength(6);
        expectRender(cells[2]).toContain("map<string, string>");
        expectRender(cells[4]).toContain("cached prefix stays valid");
        // Two asterisks in one prose cell would pair into emphasis and vanish;
        // the generator escapes them so the wildcard reads as written.
        expectRender(cells[4]).toContain("provider/\\*");
        expectRender(cells[4]).not.toMatch(/provider\/\*[^\\]/);
    });
});

test("GitHub live key list and generated site badges match schema marks", async () => {
    const { buildSchema } = await import("./build-schema");
    const schema = buildSchema() as { properties: Record<string, unknown> };
    const marked: string[] = [];
    const walk = (value: unknown, path = "") => {
        const node = value as { properties?: Record<string, unknown>; "x-mc-live-reload"?: boolean };
        if (node["x-mc-live-reload"] === true) marked.push(path);
        for (const [key, child] of Object.entries(node.properties ?? {})) {
            walk(child, path ? `${path}.${key}` : key);
        }
    };
    walk(schema);
    const github = fs.readFileSync(path.resolve(import.meta.dir, "../../..", "CONFIGURATION.md"), "utf8");
    const { buildGitHubLiveKeys } = await import("./build-config-docs");
    expect(github).toBe(buildGitHubLiveKeys(github));
    const block = github.match(/<!-- LIVE-CONFIG-KEYS-START -->([\s\S]*?)<!-- LIVE-CONFIG-KEYS-END -->/);
    expect(block).not.toBeNull();
    const listed = [...(block?.[1] ?? "").matchAll(/^- `([^`]+)`$/gm)].map((match) => match[1]);
    expect(listed).toEqual(marked.sort());
    const site = fs.readFileSync(path.resolve(import.meta.dir, "../../docs/src/content/docs/reference/configuration.md"), "utf8");
    expect(site).toContain("## Changing config without a restart");
    for (const key of marked) {
        expect(site).toContain(`| \`${key}\` **Live** |`);
    }
});
