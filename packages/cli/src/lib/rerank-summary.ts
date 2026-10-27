import type { RerankConfig } from "@magic-context/core/config/schema/magic-context";

/** Do not echo routing or credential strings: hosted errors and config summaries must be safe to share. */
export function rerankConfigSummary(config?: RerankConfig): string {
    if (config?.provider === "remote") {
        return `Reranking: remote (explicit ctx_search only; timeout ${config.timeout_ms}ms, top_n ${config.top_n}; credentials hidden)`;
    }
    return config?.provider === "off"
        ? "Reranking: off"
        : "Reranking: local Synapse (default; explicit ctx_search only)";
}
