import type { StatusDetail } from "./rpc-types";
import { renderUserStatusSummary, statusSummaryFromDetail } from "./status-summary";

/** Render the status summary for chat-only OpenCode clients (no TUI dialog). */
export function formatStatusDetailMarkdown(detail: StatusDetail): string {
    return renderUserStatusSummary(statusSummaryFromDetail(detail), "markdown");
}
