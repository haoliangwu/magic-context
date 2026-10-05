/**
 * Which config key an OpenCode host reads plugin registrations from.
 *
 * OpenCode 1.18.x reads the singular `plugin` array. OpenCode 2 reads the native
 * `plugins` array AND still decodes the legacy `plugin` array, concatenating both
 * (`@opencode/core@2.0.11` config normalizer: `encoded.plugins = [...legacy, ...native]`).
 * A tool that only inspects `plugin` on a 2.x host therefore misses a registration
 * the user made under `plugins` and, by adding a second entry under `plugin`, loads
 * the plugin twice. Every reader must look at BOTH keys; every writer must target
 * the key the running host generation calls its own.
 */
import type { OpenCodeHostGeneration } from "@magic-context/core/shared/opencode-db-path";

export const OPENCODE_PLUGIN_CONFIG_KEYS = ["plugin", "plugins"] as const;
export type OpenCodePluginConfigKey = (typeof OPENCODE_PLUGIN_CONFIG_KEYS)[number];

/** The key a fresh registration is written under on the given host generation. */
export function pluginConfigKeyFor(
    hostGeneration: OpenCodeHostGeneration,
): OpenCodePluginConfigKey {
    return hostGeneration === "v2" ? "plugins" : "plugin";
}

/** Every plugin entry the host would load, across both keys, with the key each came from. */
export function readPluginEntries(
    config: Record<string, unknown> | null | undefined,
): Array<{ key: OpenCodePluginConfigKey; index: number; entry: unknown }> {
    const out: Array<{ key: OpenCodePluginConfigKey; index: number; entry: unknown }> = [];
    for (const key of OPENCODE_PLUGIN_CONFIG_KEYS) {
        const list = config?.[key];
        if (!Array.isArray(list)) continue;
        for (const [index, entry] of list.entries()) out.push({ key, index, entry });
    }
    return out;
}
