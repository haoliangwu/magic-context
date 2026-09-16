import type { EmbeddingFailureClass } from "../features/magic-context/memory/embedding-failure";
import type { PromptFailureClass } from "./model-suggestion-retry";

export const USER_FACING_FAILURES = {
    historian_unavailable: {
        code: "MC-H01",
        sentence: "History compression could not finish this turn.",
        action: "It will retry automatically.",
    },
    recomp_unavailable: {
        code: "MC-R01",
        sentence: "History compression could not be rebuilt.",
        action: "Run /ctx-recomp again.",
    },
    dream_provider_timeout: {
        code: "MC-D01",
        sentence: "Memory maintenance took too long to respond.",
        action: "Run /ctx-dream again.",
    },
    dream_provider_error: {
        code: "MC-D02",
        sentence: "Memory maintenance could not reach its model.",
        action: "Check the model connection, then run /ctx-dream again.",
    },
    dream_empty_completion: {
        code: "MC-D03",
        sentence: "Memory maintenance received no usable response.",
        action: "Run /ctx-dream again.",
    },
    dream_no_models: {
        code: "MC-D04",
        sentence: "Memory maintenance has no model available.",
        action: "Check the model settings, then run /ctx-dream again.",
    },
    dream_child_aborted: {
        code: "MC-D05",
        sentence: "Memory maintenance was interrupted.",
        action: "Run /ctx-dream again.",
    },
    dream_parse_failed: {
        code: "MC-D06",
        sentence: "Memory maintenance could not use the model response.",
        action: "Run /ctx-dream again.",
    },
    dream_unknown: {
        code: "MC-D07",
        sentence: "Memory maintenance could not finish.",
        action: "Run /ctx-dream again.",
    },
    embedding_substitution_rejected: {
        code: "MC-E01",
        sentence: "Search indexing could not use the selected model.",
        action: "Check the embedding model setting, then run /ctx-embed start again.",
    },
    embedding_http_error: {
        code: "MC-E02",
        sentence: "The search indexing provider refused the request.",
        action: "Check the provider connection and credentials, then run /ctx-embed start again.",
    },
    embedding_transport_error: {
        code: "MC-E03",
        sentence: "Search indexing could not reach its provider.",
        action: "Check the connection, then run /ctx-embed start again.",
    },
    embedding_invalid_envelope: {
        code: "MC-E04",
        sentence: "Search indexing received an unsupported response.",
        action: "Check the embedding endpoint, then run /ctx-embed start again.",
    },
    embedding_empty_result: {
        code: "MC-E05",
        sentence: "Search indexing received no usable result.",
        action: "Run /ctx-embed start again.",
    },
    embedding_certification_refusal: {
        code: "MC-E06",
        sentence: "Search indexing is not ready for this provider.",
        action: "Finish the provider setup, or set a fallback provider in the embedding settings, then run /ctx-embed start again.",
    },
    embedding_credential_required: {
        code: "MC-E07",
        sentence: "Search indexing needs provider credentials.",
        action: "Sign in to the provider, then run /ctx-embed start again.",
    },
    embedding_local_binding_missing: {
        code: "MC-E08",
        sentence: "Local search indexing is unavailable on this system.",
        action: "Run `npx @cortexkit/magic-context doctor`, then retry.",
    },
    embedding_local_fs_unavailable: {
        code: "MC-E09",
        sentence: "Local search indexing cannot save its model files.",
        action: "Update or reinstall Magic Context, then retry.",
    },
    embedding_local_download_failure: {
        code: "MC-E10",
        sentence: "Local search indexing could not download its model.",
        action: "Check the network connection, then retry.",
    },
    embedding_local_runtime_error: {
        code: "MC-E11",
        sentence: "Local search indexing could not start.",
        action: "Run `npx @cortexkit/magic-context doctor`, then retry.",
    },
    embedding_unavailable: {
        code: "MC-E12",
        sentence: "Search indexing could not finish.",
        action: "Run /ctx-embed start again.",
    },
    status_unavailable: {
        code: "MC-S01",
        sentence: "Magic Context status is temporarily unavailable.",
        action: "Retry /ctx-status in a moment.",
    },
    transform_update_failed: {
        code: "MC-S02",
        sentence: "The last context update did not finish.",
        action: "Send another message to retry.",
    },
    configuration_warning: {
        code: "MC-S03",
        sentence: "Some configuration settings could not be applied.",
        action: "Fix the configuration warning shown in /ctx-status diagnostics, then restart.",
    },
    status_log_unavailable: {
        code: "MC-S04",
        sentence: "Some diagnostic details could not be saved.",
        action: "Retry /ctx-status in a moment.",
    },
    memory_writes_paused: {
        code: "MC-C01",
        sentence: "Memory writes are paused while the engine syncs.",
        action: "Retry in a moment.",
    },
    memory_access_unavailable: {
        code: "MC-C02",
        sentence: "Memory access is temporarily unavailable.",
        action: "Retry in a moment.",
    },
    note_changes_paused: {
        code: "MC-C03",
        sentence: "Note changes are paused while the engine syncs.",
        action: "Retry in a moment.",
    },
    note_access_unavailable: {
        code: "MC-C04",
        sentence: "Notes are temporarily unavailable.",
        action: "Retry in a moment.",
    },
    context_cleanup_paused: {
        code: "MC-C05",
        sentence: "Context cleanup is paused while the engine syncs.",
        action: "Retry in a moment.",
    },
    partial_history_unavailable: {
        code: "MC-C06",
        sentence: "Partial history compression is not available in the current mode.",
        action: "Run /ctx-recomp without a range.",
    },
    session_upgrade_unavailable: {
        code: "MC-C07",
        sentence: "Session upgrade is not available in the current mode.",
        action: "Run /ctx-recomp instead.",
    },
    smart_note_conditions_unavailable: {
        code: "MC-C08",
        sentence: "Conditional notes are not available in the current mode.",
        action: "Save a regular note without a condition.",
    },
    history_compression_paused: {
        code: "MC-C09",
        sentence: "History compression is paused while the engine syncs.",
        action: "Retry in a moment.",
    },
    context_service_unavailable: {
        code: "MC-C10",
        sentence: "Magic Context is temporarily unavailable.",
        action: "Retry in a moment.",
    },
    memory_mirror_stalled: {
        code: "MC-M01",
        sentence: "Memory synchronization stopped before the host mirror caught up.",
        action: "Send another message to resume it, or run `ck doctor drain-authority`.",
    },
    memory_authority_mismatch: {
        code: "MC-M02",
        sentence: "Memory authority is inconsistent between the host and module.",
        action: "Run `ck doctor drain-authority` before changing Rust mode.",
    },
} as const;

export type UserFacingFailureKey = keyof typeof USER_FACING_FAILURES;

export type UserFacingTextStyle = "markdown" | "plain";

export function renderUserFacingFailure(
    key: UserFacingFailureKey,
    style: UserFacingTextStyle = "markdown",
): string {
    const failure = USER_FACING_FAILURES[key];
    const action = style === "plain" ? failure.action.replaceAll("`", "") : failure.action;
    return `${failure.sentence} ${action} (${failure.code})`;
}

export function userFacingFailureCode(key: UserFacingFailureKey): string {
    return USER_FACING_FAILURES[key].code;
}

export type CapabilityRefusal =
    | "memory_write"
    | "memory_access"
    | "note_change"
    | "note_access"
    | "context_cleanup"
    | "partial_history"
    | "session_upgrade"
    | "smart_note_condition"
    | "history_compression"
    | "context_service";

const CAPABILITY_FAILURES: Record<CapabilityRefusal, UserFacingFailureKey> = {
    memory_write: "memory_writes_paused",
    memory_access: "memory_access_unavailable",
    note_change: "note_changes_paused",
    note_access: "note_access_unavailable",
    context_cleanup: "context_cleanup_paused",
    partial_history: "partial_history_unavailable",
    session_upgrade: "session_upgrade_unavailable",
    smart_note_condition: "smart_note_conditions_unavailable",
    history_compression: "history_compression_paused",
    context_service: "context_service_unavailable",
};

export function renderCapabilityRefusal(capability: CapabilityRefusal): string {
    return renderUserFacingFailure(CAPABILITY_FAILURES[capability]);
}

export function capabilityRefusalCode(capability: CapabilityRefusal): string {
    return userFacingFailureCode(CAPABILITY_FAILURES[capability]);
}

const DREAM_FAILURE_KEYS = {
    provider_timeout: "dream_provider_timeout",
    provider_error: "dream_provider_error",
    empty_completion: "dream_empty_completion",
    no_models: "dream_no_models",
    child_aborted: "dream_child_aborted",
    parse_failed: "dream_parse_failed",
    unknown: "dream_unknown",
} as const satisfies Record<PromptFailureClass, UserFacingFailureKey>;

const EMBEDDING_FAILURE_KEYS = {
    substitution_rejected: "embedding_substitution_rejected",
    http_error: "embedding_http_error",
    transport_error: "embedding_transport_error",
    invalid_envelope: "embedding_invalid_envelope",
    empty_result: "embedding_empty_result",
    certification_refusal: "embedding_certification_refusal",
    credential_required: "embedding_credential_required",
    local_binding_missing: "embedding_local_binding_missing",
    local_fs_unavailable: "embedding_local_fs_unavailable",
    local_download_failure: "embedding_local_download_failure",
    local_runtime_error: "embedding_local_runtime_error",
} as const satisfies Record<EmbeddingFailureClass, UserFacingFailureKey>;

export function renderDreamFailure(
    failureClass: PromptFailureClass,
    style: UserFacingTextStyle = "markdown",
): string {
    return renderUserFacingFailure(DREAM_FAILURE_KEYS[failureClass], style);
}

export function dreamFailureCode(failureClass: PromptFailureClass): string {
    return userFacingFailureCode(DREAM_FAILURE_KEYS[failureClass]);
}

export function renderEmbeddingFailure(
    failureClass: EmbeddingFailureClass,
    style: UserFacingTextStyle = "markdown",
): string {
    return renderUserFacingFailure(EMBEDDING_FAILURE_KEYS[failureClass], style);
}

export function embeddingFailureCode(failureClass: EmbeddingFailureClass): string {
    return userFacingFailureCode(EMBEDDING_FAILURE_KEYS[failureClass]);
}
