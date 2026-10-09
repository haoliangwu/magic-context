import { expect, it } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { protectedToolTagNumbers } from "../features/magic-context/reclaim-protection";
import { createTestTempDirFromPath } from "../shared/test-temp-dir";
import { loadPluginConfigDetailed, parsePluginConfig } from ".";
import { MagicContextConfigSchema } from "./schema/magic-context";

it("protected_tools defaults, validation, active-only ordinals and zero override", () => {
    expect(MagicContextConfigSchema.parse({}).protected_tools).toEqual({
        todowrite: 1,
        ctx_reduce: 3,
    });
    for (const value of [-1, 1.5, "2", null])
        expect(
            MagicContextConfigSchema.safeParse({ protected_tools: { custom: value } }).success,
        ).toBe(false);
    const tags = [1, 2, 3, 4, 5].map((tagNumber) => ({
        tagNumber,
        toolName: tagNumber % 2 ? "MCP_CUSTOM" : "custom",
        type: "tool",
        status: tagNumber === 5 ? "compacted" : tagNumber === 4 ? "dropped" : "active",
    }));
    expect([...protectedToolTagNumbers(tags, { custom: 2 })]).toEqual([3, 2]);
    expect([...protectedToolTagNumbers(tags, { custom: 0 })]).toEqual([]);
    expect(parsePluginConfig({ smart_drops: false }).configWarnings).toContain(
        "smart_drops is deprecated and ignored; supersession reclaim is always on. This key no longer does anything; remove it.",
    );
    expect(MagicContextConfigSchema.safeParse({ smart_drops: "ignored" }).success).toBe(true);
});

it("protected_tools does not treat inherited object keys as configured tools", () => {
    const tags = ["constructor", "__proto__"].map((toolName, i) => ({
        tagNumber: i + 1,
        toolName,
        type: "tool",
        status: "active",
    }));
    expect([...protectedToolTagNumbers(tags)]).toEqual([]);
    expect([...protectedToolTagNumbers(tags, { constructor: 1 })]).toEqual([1]);
});

it("protected_tools merges normalized project keys over user and shipped defaults", () => {
    const dir = createTestTempDirFromPath(join(tmpdir(), "protected-tools-config-"));
    const old = process.env.XDG_CONFIG_HOME;
    try {
        const project = join(dir, "project");
        mkdirSync(join(dir, "cortexkit"), { recursive: true });
        mkdirSync(join(project, ".cortexkit"), { recursive: true });
        writeFileSync(
            join(dir, "cortexkit/magic-context.jsonc"),
            JSON.stringify({ protected_tools: { MCP_CUSTOM: 3, todowrite: 0 } }),
        );
        writeFileSync(
            join(project, ".cortexkit/magic-context.jsonc"),
            JSON.stringify({ protected_tools: { custom: 2, CTX_REDUCE: 1 } }),
        );
        process.env.XDG_CONFIG_HOME = dir;
        expect(loadPluginConfigDetailed(project).config.protected_tools).toEqual({
            custom: 2,
            todowrite: 0,
            ctx_reduce: 1,
        });
    } finally {
        if (old === undefined) delete process.env.XDG_CONFIG_HOME;
        else process.env.XDG_CONFIG_HOME = old;
        rmSync(dir, { recursive: true, force: true });
    }
});
