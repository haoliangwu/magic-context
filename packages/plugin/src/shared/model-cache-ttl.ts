import { canonicalModelIdentity } from "./harness-provider-map";
import { resolveModelConfigValue } from "./prompt-surface";

export type CacheTtlConfig = string | Record<string, string>;
export type CacheTtlSource = "config" | "default" | "OpenAI GPT-5.6+ default";
export interface ResolvedCacheTtl {
    value: string;
    source: CacheTtlSource;
    modelKey: string | undefined;
}

// Provider documentation: https://developers.openai.com/api/docs/guides/prompt-caching
// Cache lifetime / Summary of model differences: at least 30 minutes since write or reuse.
const MODEL_CACHE_LIFETIMES = [
    {
        source: "OpenAI GPT-5.6+ default" as const,
        value: "30m",
        matches(model: string): boolean {
            const version = /^gpt-(\d+)(?:\.(\d+))?(?:$|[^\d.])/.exec(model);
            if (!version) return false;
            const major = Number(version[1]);
            const minor = Number(version[2] ?? 0);
            return major > 5 || (major === 5 && minor >= 6);
        },
    },
];

export function resolveModelCacheTtl(
    config: CacheTtlConfig | undefined,
    modelKey: string | undefined,
    configuredExplicitly = typeof config === "object" ||
        (typeof config === "string" && config !== "5m"),
): ResolvedCacheTtl {
    if (config && typeof config !== "string") {
        const match =
            modelKey &&
            !modelKey.includes("/") &&
            Object.hasOwn(config, modelKey) &&
            modelKey !== "default"
                ? config[modelKey]
                : resolveModelConfigValue(config, modelKey)?.value;
        const value = match ?? config.default;
        if (value !== undefined && configuredExplicitly)
            return { value, source: "config", modelKey };
    }
    // The loader supplies provenance: an explicit 5m is policy too. Older callers
    // without that bit still distinguish non-default strings from the schema's 5m.
    if (typeof config === "string" && configuredExplicitly)
        return { value: config, source: "config", modelKey };
    const model =
        canonicalModelIdentity(modelKey ?? "")
            .toLowerCase()
            .split("/")
            .at(-1) ?? "";
    const known = MODEL_CACHE_LIFETIMES.find((entry) => entry.matches(model));
    if (known) return { value: known.value, source: known.source, modelKey };
    return {
        value: (typeof config === "object" ? config.default : config) ?? "5m",
        source: "default",
        modelKey,
    };
}
