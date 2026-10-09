import type { MagicContextConfig } from "../config/schema/magic-context";
import { type ResolvedCacheTtl, resolveModelCacheTtl } from "./model-cache-ttl";

export type CacheTtlDisplaySource = ResolvedCacheTtl["source"] | "session";

export interface CacheTtlDisplay {
    value: string;
    source: CacheTtlDisplaySource;
    modelKey: string | undefined;
}

export interface ResolveCacheTtlDisplayArgs {
    frozen?: ResolvedCacheTtl & { builtInDefault?: ResolvedCacheTtl };
    configured: MagicContextConfig["cache_ttl"];
    configuredExplicitly: boolean;
    modelKey: string | undefined;
    sessionValue: string;
    /** Model key persisted with the last completed assistant response. */
    sessionModelKey: string | null;
}

/**
 * Resolve the lifetime shown in status without changing the value saved for the scheduler.
 * The next pass uses current settings; a saved built-in lifetime applies only to the same
 * model, even after an override is removed.
 */
export function resolveCacheTtlDisplay(args: ResolveCacheTtlDisplayArgs): CacheTtlDisplay {
    const resolved = resolveModelCacheTtl(
        args.configured,
        args.modelKey,
        args.configuredExplicitly,
    );
    if (resolved.source === "config") return resolved;
    if (args.frozen && (!args.modelKey || args.frozen.modelKey === args.modelKey)) {
        return args.frozen.source === "config"
            ? (args.frozen.builtInDefault ?? resolved)
            : args.frozen;
    }
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

    return resolved;
}

export function formatCacheTtlDisplay(display: CacheTtlDisplay): string {
    if (display.source === "session") return `Cache TTL: ${display.value} (session)`;
    if (display.source === "config") {
        return `Cache TTL: ${display.value} (your config)`;
    }
    return `Cache TTL: ${display.value} (built-in default, frozen for this session)`;
}
