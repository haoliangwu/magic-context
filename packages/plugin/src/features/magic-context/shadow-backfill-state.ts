import type { Database } from "../../shared/sqlite";

const SHADOW_BACKFILL_PROVENANCE_KEY = "_magicContextShadowBackfill";

export type ShadowScope = "memory" | "commit" | "chunk";
export type ShadowBackfillStopReason = "drained" | "stalled_no_progress";
export type ShadowBackfillWriteRefusalReason =
    | "provider_returned_no_vectors"
    | "memory_hash_guard_rejected"
    | "candidate_rows_changed"
    | "registration_retired_during_embed"
    | "chunk_fts_mapping_incomplete"
    | "chunk_empty_canonical_text"
    | "chunk_partial_vector_set"
    | "chunk_window_contract_mismatch"
    | "duplicate_submission_budget"
    | "unknown_write_rejection";

export interface PersistedShadowBackfillState {
    version: 1;
    stopReason?: ShadowBackfillStopReason;
    candidateSignature?: string;
    writeRefusalReason?: ShadowBackfillWriteRefusalReason;
    stoppedAt?: number;
    budgetLogRequestKey?: string;
    budgetLoggedAt?: number;
}

export interface ShadowBackfillStall {
    projectIdentity: string;
    scope: ShadowScope;
    modelId: string;
    candidateSignature: string;
    writeRefusalReason: ShadowBackfillWriteRefusalReason;
    stoppedAt: number;
}

function parseJsonRecord(value: string): Record<string, unknown> {
    try {
        const parsed = JSON.parse(value) as unknown;
        return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
            ? (parsed as Record<string, unknown>)
            : {};
    } catch {
        return {};
    }
}

export function parsePersistedShadowBackfillState(
    provenanceJson: string,
): PersistedShadowBackfillState | undefined {
    const raw = parseJsonRecord(provenanceJson)[SHADOW_BACKFILL_PROVENANCE_KEY];
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
    const state = raw as Record<string, unknown>;
    if (state.version !== 1) return undefined;
    return state as unknown as PersistedShadowBackfillState;
}

function hasShadowEmbeddingRegistrationsTable(db: Database): boolean {
    return Boolean(
        db
            .prepare(
                "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'shadow_embedding_registrations'",
            )
            .get(),
    );
}

export function describeShadowBackfillWriteRefusal(
    reason: ShadowBackfillWriteRefusalReason,
): string {
    switch (reason) {
        case "provider_returned_no_vectors":
            return "the provider returned no vectors";
        case "memory_hash_guard_rejected":
            return "the memory normalized-hash guard rejected vectors because content changed in flight";
        case "candidate_rows_changed":
            return "the selected source rows changed before the writer loaded them";
        case "registration_retired_during_embed":
            return "the shadow registration was retired or replaced while the provider call was in flight, so the vectors were discarded";
        case "chunk_fts_mapping_incomplete":
            return "the chunk writer refused rows whose transcript ordinals are not fully mapped in FTS";
        case "chunk_empty_canonical_text":
            return "the chunk writer produced no canonical windows";
        case "chunk_partial_vector_set":
            return "the chunk writer refused a partial provider result so it would not replace a compartment incompletely";
        case "chunk_window_contract_mismatch":
            return "written chunk window keys or hashes did not satisfy the selector's window contract";
        case "duplicate_submission_budget":
            return "the same content batch was already submitted within the one-hour provider budget";
        default:
            return "the write completed without satisfying the selected candidate";
    }
}

export function formatShadowBackfillStall(stall: ShadowBackfillStall): string {
    return (
        `Shadow ${stall.scope} backfill for ${stall.projectIdentity} stopped with stalled_no_progress: ` +
        describeShadowBackfillWriteRefusal(stall.writeRefusalReason)
    );
}

export function listShadowBackfillStalls(
    db: Database,
    projectIdentity?: string,
): ShadowBackfillStall[] {
    if (!hasShadowEmbeddingRegistrationsTable(db)) return [];
    const rows = db
        .prepare(
            `SELECT project_path AS projectIdentity, scope, model_id AS modelId,
                    provenance_json AS provenanceJson
             FROM shadow_embedding_registrations
             ${projectIdentity ? "WHERE project_path = ?" : ""}
             ORDER BY updated_at DESC, generation DESC`,
        )
        .all(...(projectIdentity ? [projectIdentity] : [])) as Array<{
        projectIdentity: string;
        scope: ShadowScope;
        modelId: string;
        provenanceJson: string;
    }>;
    const latestScopes = new Set<string>();
    const stalls: ShadowBackfillStall[] = [];
    for (const row of rows) {
        const scopeKey = `${row.projectIdentity}:${row.scope}`;
        if (latestScopes.has(scopeKey)) continue;
        latestScopes.add(scopeKey);
        const state = parsePersistedShadowBackfillState(row.provenanceJson);
        if (state?.stopReason !== "stalled_no_progress") continue;
        stalls.push({
            projectIdentity: row.projectIdentity,
            scope: row.scope,
            modelId: row.modelId,
            candidateSignature: state.candidateSignature ?? "unknown",
            writeRefusalReason: state.writeRefusalReason ?? "unknown_write_rejection",
            stoppedAt: state.stoppedAt ?? 0,
        });
    }
    return stalls;
}
