import { formatCacheTtlDisplay } from "./cache-ttl-display";
import { formatConfigParseStatusLine } from "./config-diagnostics";
import {
    formatOpenCodeDbMissingStatusLine,
    formatOpenCodeDbReadFailureStatusLine,
    getOpenCodeDbReadFailure,
    openCodeDbPathExists,
    resolveOpenCodeDbPath,
} from "./opencode-db-path";
import type { StatusDetail } from "./rpc-types";
import { RUST_MODE_HOST_PATHS_LINE } from "./rust-mode-status";
import { renderUserStatusSummary, statusSummaryFromDetail } from "./status-summary";
import { renderUserFacingFailure } from "./user-facing-codes";

function formatCount(value: number): string {
    return Math.round(value).toLocaleString();
}

function formatCacheLane(detail: StatusDetail): string {
    if (detail.cacheNeverExpires) return `never expires; TTL ${detail.cacheTtl}`;
    if (detail.lastResponseTime <= 0) return `waiting for first response; TTL ${detail.cacheTtl}`;
    if (detail.cacheExpired) return `expired; TTL ${detail.cacheTtl}`;
    return `live (${Math.round(detail.cacheRemainingMs / 1000)}s remaining); TTL ${detail.cacheTtl}`;
}

/** Render the default user summary for chat-only OpenCode clients. */
export function formatStatusDetailMarkdown(detail: StatusDetail): string {
    return renderUserStatusSummary(statusSummaryFromDetail(detail), "markdown");
}

/** Render the opt-in operator detail that the status dialog exposes behind Diagnostics. */
export function formatStatusDiagnosticsMarkdown(detail: StatusDetail): string {
    const usableLimit =
        detail.contextLimit > 0
            ? `${formatCount(detail.contextLimit)} usable tokens`
            : "? usable tokens";
    const historianState = detail.historianRunning ? "running" : "idle";
    const historianDetails = [
        detail.boundaryPresent === undefined
            ? undefined
            : `boundary ${detail.boundaryPresent ? "present" : "absent"}`,
        detail.coverageOrdinal === undefined
            ? undefined
            : `coverage ${detail.coverageOrdinal === null ? "none" : detail.coverageOrdinal}`,
    ].filter((value): value is string => value !== undefined);
    const openCodeDbResolution = resolveOpenCodeDbPath();
    const openCodeDbReadFailure = getOpenCodeDbReadFailure();
    const openCodeDbStatusLine = !openCodeDbPathExists(openCodeDbResolution)
        ? formatOpenCodeDbMissingStatusLine(openCodeDbResolution)
        : openCodeDbReadFailure?.path === openCodeDbResolution.path
          ? formatOpenCodeDbReadFailureStatusLine(openCodeDbReadFailure)
          : null;
    const mode =
        detail.compaction_enabled === false
            ? "native compaction (Magic Context history compaction disabled)"
            : "Magic Context compaction";

    const lines = [
        ...(openCodeDbStatusLine ? [openCodeDbStatusLine, ""] : []),
        ...(detail.configParseFailures ?? []).map(formatConfigParseStatusLine),
        ...((detail.configParseFailures?.length ?? 0) > 0 ? [""] : []),
        "## Magic Context Status",
        "",
        `- **Mode:** ${mode}`,
        `- **Active profile:** ${detail.activeProfile ?? "none"}`,
        `- **Usage:** ${detail.usagePercentage.toFixed(1)}% (${formatCount(detail.inputTokens)} / ${usableLimit})`,
        `- **${formatCacheTtlDisplay({ value: detail.cacheTtl, source: detail.cacheTtlSource ?? "session", modelKey: detail.cacheTtlModelKey })}**; ${formatCacheLane(detail)}`,
        `- **Historian:** ${[historianState, ...historianDetails].join("; ")}`,
        ...(detail.hostBackendsModuleSide ? [`- ${RUST_MODE_HOST_PATHS_LINE}`] : []),
        ...(detail.memoryMirror
            ? [
                  `- **Memory mirror:** cursor ${formatCount(detail.memoryMirror.cursor)} / ${detail.memoryMirror.feedHead === null ? "unknown" : formatCount(detail.memoryMirror.feedHead)}; ${formatCount(detail.memoryMirror.liveRows)} live rows; ${detail.memoryMirror.stalled ? `stalled (${detail.memoryMirror.code})` : "advancing or caught up"}`,
              ]
            : []),
        `- **Memory:** ${formatCount(detail.memoryCount)} active; ${formatCount(detail.memoryBlockCount)} injected`,
        `- **Tags:** ${formatCount(detail.activeTags)} active, ${formatCount(detail.droppedTags)} dropped; ${formatCount(detail.pendingOpsCount)} pending drops`,
        `- **Execute threshold:** ${detail.executeThreshold.toFixed(1)}%${detail.executeThresholdClamped ? " (clamped)" : ""}`,
    ];

    if (detail.recompProgress?.phase === "recomp") {
        lines.push(
            `- **${detail.recompProgress.kind === "embed" ? "Embed" : "Historian"} progress:** ${formatCount(detail.recompProgress.processedMessages)} / ${formatCount(detail.recompProgress.totalMessages)}`,
        );
    }
    if (detail.lastTransformError) {
        lines.push(`- **Warning:** ${renderUserFacingFailure("transform_update_failed")}`);
    }
    if (detail.memoryMirror?.stalled) {
        lines.push(`- **Warning:** ${renderUserFacingFailure("memory_mirror_stalled")}`);
    }
    if (detail.memoryAuthorityMismatch) {
        lines.push(`- **Warning:** ${renderUserFacingFailure("memory_authority_mismatch")}`);
    }

    return lines.join("\n");
}
