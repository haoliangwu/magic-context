import type { MagicContextConfig } from "../config/schema/magic-context";
import { type ResolvedCacheTtl, resolveModelCacheTtl } from "./model-cache-ttl";

export type CacheTtlDisplaySource = ResolvedCacheTtl["source"] | "session";

export interface CacheTtlDisplay {
    value: string;
    source: CacheTtlDisplaySource;
    modelKey: string | undefined;
}

export interface ResolveCacheTtlDisplayArgs {
    frozen?: ResolvedCacheTtl;
    configured: MagicContextConfig["cache_ttl"];
    configuredExplicitly: boolean;
    modelKey: string | undefined;
    sessionValue: string;
    /** Model key persisted with the last completed assistant response. */
    sessionModelKey: string | null;
}

/**
 * Resolve status-only TTL text without changing the scheduler's persisted truth.
 * Use the session value only when its persisted model key matches the model being
 * displayed; otherwise use live config because the session value may be for another model.
 */
export function resolveCacheTtlDisplay(args: ResolveCacheTtlDisplayArgs): CacheTtlDisplay {
    if (args.frozen) return args.frozen;
    if (
        (args.sessionModelKey && (!args.modelKey || args.sessionModelKey === args.modelKey)) ||
        (!args.modelKey && !args.sessionModelKey && args.sessionValue !== "5m")
    ) {
        return {
            value: args.sessionValue || "5m",
            source: "session",
            modelKey: args.modelKey ?? args.sessionModelKey ?? undefined,
        };
    }

    const resolved = resolveModelCacheTtl(args.configured, args.modelKey);
    if (
        resolved.source === "default" &&
        typeof args.configured === "string" &&
        args.configuredExplicitly
    )
        return { ...resolved, source: "config" };
    return resolved;
}

export function formatCacheTtlDisplay(display: CacheTtlDisplay): string {
    if (display.source === "OpenAI GPT-5.6+ default")
        return `Cache TTL: ${display.value} (${display.source})`;
    if (display.source === "session") return `Cache TTL: ${display.value} (session)`;
    if (display.source === "config") {
        return `Cache TTL: ${display.value} (config for ${display.modelKey ?? "current model"})`;
    }
    return `Cache TTL: ${display.value} (default — no cache_ttl for ${display.modelKey ?? "unknown model"})`;
}
