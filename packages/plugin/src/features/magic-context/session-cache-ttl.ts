import {
    type CacheTtlConfig,
    type ResolvedCacheTtl,
    resolveModelCacheTtl,
} from "../../shared/model-cache-ttl";
import type { ContextDatabase } from "./storage-db";
import { getOrCreateSessionMeta, updateSessionMeta } from "./storage-meta";
import { readReplayEnvelope, updateReplayDocument } from "./storage-replay-document";

interface SessionCacheTtl extends ResolvedCacheTtl {
    config: CacheTtlConfig;
}

export function readSessionCacheTtl(
    db: ContextDatabase,
    sessionId: string,
): SessionCacheTtl | undefined {
    const saved = readReplayEnvelope(db, sessionId).cacheTtlPolicy as SessionCacheTtl | undefined;
    return saved && typeof saved.value === "string" && saved.config !== undefined
        ? saved
        : undefined;
}

/** Freeze config once the model is known; a real model switch still selects its own lifetime. */
export function resolveSessionCacheTtl(
    db: ContextDatabase,
    sessionId: string,
    config: CacheTtlConfig | undefined,
    modelKey: string | undefined,
): ResolvedCacheTtl {
    const meta = getOrCreateSessionMeta(db, sessionId);
    let saved = readSessionCacheTtl(db, sessionId);
    if (!modelKey) return saved ?? resolveModelCacheTtl(config ?? meta.cacheTtl, undefined);
    if (!saved || saved.modelKey !== modelKey) {
        const frozenConfig = saved?.config ?? config ?? meta.cacheTtl;
        const resolved = resolveModelCacheTtl(frozenConfig, modelKey);
        const next = { ...resolved, config: frozenConfig };
        // Reuse the extensible replay document so restart preserves the decision
        // without a schema migration or a process-local session cache.
        if (
            !updateReplayDocument(db, sessionId, (doc) => {
                doc.version = 2;
                doc.cacheTtlPolicy = next;
                return true;
            })
        )
            throw new Error("cannot persist session cache TTL policy");
        saved = next;
    }
    if (meta.cacheTtl !== saved.value) updateSessionMeta(db, sessionId, { cacheTtl: saved.value });
    return saved;
}
