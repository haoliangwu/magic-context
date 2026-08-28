/**
 * compat/dsh-0.1 — the DSH compatibility layer (PLAN §2).
 *
 * Every `@deepseek-ai/dsh-*` import in this adapter lives behind this layer.
 * DSH upgrades原则上 only touch this directory, its contract fixtures, and the
 * dependency lock. The adapter's feature code depends only on this layer and
 * on the merged shared harness (src/shared/dsh-harness) + core
 * harness-provider-map.
 */
export * from "./session";
export * from "./compaction";
export * from "./prestep";
export * from "./tools";
export * from "./commands";
export * from "./subagent";
export * from "./remote-seam";
export * from "./liveness";
export * from "./preset";
