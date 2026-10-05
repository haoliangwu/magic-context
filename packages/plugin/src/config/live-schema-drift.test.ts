import { expect, test } from "bun:test";

import { buildSchema } from "../../scripts/build-schema";
import { sampleLiveConfig } from "./live-run-config";
import { LIVE_RELOAD_CONFIG_PATHS, type MagicContextConfig } from "./schema/magic-context";

type SchemaNode = { properties?: Record<string, SchemaNode>; "x-mc-live-reload"?: boolean };

function leaves(node: SchemaNode, prefix = ""): Array<{ path: string; marked: boolean }> {
    return Object.entries(node.properties ?? {}).flatMap(([key, child]) => {
        const path = prefix ? `${prefix}.${key}` : key;
        return child.properties
            ? leaves(child, path)
            : [{ path, marked: child["x-mc-live-reload"] === true }];
    });
}

function assign(target: Record<string, unknown>, path: string, value: unknown): void {
    const keys = path.split(".");
    let node = target;
    for (const key of keys.slice(0, -1)) {
        node[key] ??= {};
        node = node[key] as Record<string, unknown>;
    }
    node[keys.at(-1)!] = value;
}

function lookup(target: Record<string, unknown>, path: string): unknown {
    return path
        .split(".")
        .reduce<unknown>(
            (node, key) => (node as Record<string, unknown> | undefined)?.[key],
            target,
        );
}

test("schema live marks equal the keys sampled by producer consumers and published JSON schema", async () => {
    const generated = buildSchema() as SchemaNode;
    const published = (await Bun.file(
        new URL("../../../../assets/magic-context.schema.json", import.meta.url),
    ).json()) as SchemaNode;
    const generatedLive = leaves(generated)
        .filter((row) => row.marked)
        .map((row) => row.path)
        .sort();
    const publishedLive = leaves(published)
        .filter((row) => row.marked)
        .map((row) => row.path)
        .sort();
    const boot = {} as Record<string, unknown>;
    const fresh = {} as Record<string, unknown>;
    for (const row of leaves(generated)) assign(fresh, row.path, `changed:${row.path}`);
    const sampled = sampleLiveConfig(
        boot as MagicContextConfig,
        fresh as MagicContextConfig,
    ) as Record<string, unknown>;
    const consumed = leaves(generated)
        .filter((row) => lookup(sampled, row.path) === `changed:${row.path}`)
        .map((row) => row.path)
        .sort();
    expect(generatedLive).toEqual([...LIVE_RELOAD_CONFIG_PATHS].sort());
    expect(publishedLive).toEqual(generatedLive);
    expect(consumed).toEqual(generatedLive);
    expect(generatedLive).not.toContain("language");
    expect(generatedLive).not.toContain("historian.top_p");
    expect(generatedLive).not.toContain("protected_tokens");
});
