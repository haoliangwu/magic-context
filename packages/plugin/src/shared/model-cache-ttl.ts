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
): ResolvedCacheTtl {
    if (config && typeof config !== "string") {
        const match =
            modelKey &&
            !modelKey.includes("/") &&
            Object.hasOwn(config, modelKey) &&
            modelKey !== "default"
                ? config[modelKey]
                : resolveModelConfigValue(config, modelKey)?.value;
        if (match !== undefined) return { value: match, source: "config", modelKey };
    }
    // A non-5m global string is an explicit policy. The generic 5m default is
    // not evidence of provider eviction: documented lifetimes avoid paid rewrites.
    if (typeof config === "string" && config !== "5m")
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
