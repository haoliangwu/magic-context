/**
 * Shared public issue-report boundary for OpenCode, Pi and OMP. Select sessions
 * and error records before removing private content, then cap the already-private
 * markdown for GitHub without sacrificing recent errors to a noisy log tail.
 */

import { IssuePrivacy } from "./issue-privacy";
import { parseLogLine } from "./log-lines";

/** Filter raw log records, then remove content for both the capped and full report. */
export function prepareIssueReport<T>(
    report: T,
    lines: string[],
    sessionFilter: string | null = null,
    projectDirectories: string[] = [process.cwd()],
) {
    const privacy = new IssuePrivacy(report, projectDirectories);
    const logLines = filterLogLinesBySession(lines, sessionFilter);
    return {
        privacy,
        report: privacy.report(report),
        logLines,
        recentLog: logLines
            .slice(-400)
            .map((line) => privacy.logLine(line))
            .join("\n")
            .trim(),
        recentErrorLines: extractRecentErrors(logLines.slice(-4000).join("\n"), 20).map((line) =>
            privacy.logLine(line),
        ),
    };
}

/**
 * GitHub issue body byte budget. GitHub enforces ~64KB (65536 bytes); we
 * leave 4KB of headroom for: GH's own URL encoding when opening the
 * "Submit new issue" tab via `gh issue create --web`, future minor
 * markdown growth from new sections, and a safety margin against any
 * single-line entry crossing the cap.
 */
export const MAX_GITHUB_BODY_BYTES = 60_000;

const LOG_TRUNCATION_MARKER = "[truncated for GitHub 64KB limit — older log lines dropped]\n";
const FINAL_TRUNCATION_MARKER = "\n\n[truncated further to fit GitHub body limit]\n";
const FALLBACK_TRUNCATION_MARKER = "\n\n[truncated for GitHub 64KB limit]\n";

/**
 * Pattern tokens that mark a log line as ERROR-shaped. Magic Context's
 * runtime uses a small, predictable vocabulary in `sessionLog(...)` calls
 * across both OpenCode and Pi plugins: `failed:`, `Error:`, `EMERGENCY`,
 * `exception`. We also pick up stack-frame lines (`    at SomeFn
 * (file:line:col)`) so the agent reading the issue sees enough context to
 * identify the call site.
 *
 * The match requires colon-suffixed keywords (`failed:` not `failed`) OR
 * the explicit `Error`/`EMERGENCY` words to qualify. That precision avoids
 * the common false positive where a sessionLog message includes "failed"
 * as past-tense status (e.g. `historian: 12 published; 0 failed` is
 * telemetry, not an error).
 */
const ERROR_LOG_PATTERNS = [
    // Common Magic Context sessionLog shapes:
    //   "transform failed: ..." / "historian prompt failed: ..." / "X failed:"
    /\bfailed:/i,
    // Standard JS/TS Error / typed-error rendering: "Error: msg", "TypeError: ...":
    /\b(?:[A-Z][a-zA-Z]*)?Error:\s/,
    // Emergency abort path emits ALL CAPS marker:
    /\bEMERGENCY\b/,
    // Magic Context turn refusals are actionable failures even when logged at INFO:
    /could not safely prepare this turn/i,
    /\bMC-H[A-Z0-9-]+\b/i,
    /\brefused\s*\(/i,
    // Generic exception/throw text:
    /\bexception\b/i,
    // V8/JSC stack-trace frames (kept so the agent gets call-site context
    // next to the failure line itself):
    /^\s+at\s+[\w.<>$]+\s+\(/,
    // Bare "    at file:line" frames (no function name):
    /^\s+at\s+(?:file:|node_modules\/|[^/\s]+:\d+)/,
];

function isErrorLogLine(line: string): boolean {
    const parsed = parseLogLine(line);
    if (parsed?.level !== null && parsed?.level !== undefined) {
        return parsed.level === "ERROR" || parsed.level === "WARN";
    }
    // A line beginning like the fleet envelope but failing its strict grammar is
    // malformed fleet output, not a legacy line eligible for text heuristics.
    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(line)) return false;
    const message = parsed?.message ?? line;
    return ERROR_LOG_PATTERNS.some((rx) => rx.test(message));
}

/**
 * Extract the most-recent error-shaped log lines for later privacy projection.
 * Returns them in chronological order (oldest match first → newest match
 * last) so the issue body reads naturally top-to-bottom.
 *
 * **Why this exists**: GitHub issue bodies have a hard ~64KB limit and the
 * 400-line log tail can easily blow past that on a long-running session.
 * If the body needs truncation, the error section MUST survive because
 * the whole point of the issue is the error. This extractor pulls them
 * into a separate section that the body-cap is careful not to drop.
 */
export function extractRecentErrors(sanitized: string, limit = 20): string[] {
    const matches: string[] = [];
    const lines = sanitized.split(/\r?\n/);
    // Walk newest-first, stop once we hit `limit`.
    for (let i = lines.length - 1; i >= 0 && matches.length < limit; i -= 1) {
        if (isErrorLogLine(lines[i])) {
            matches.push(lines[i]);
        }
    }
    return matches.reverse();
}

/**
 * Drop lines that refer to a different session. Shared runtime lines without a
 * session reference stay in the report because they may explain the failure.
 */
export function filterLogLinesBySession(lines: string[], sessionId: string | null): string[] {
    if (!sessionId) return lines;
    const otherSessionPattern = /\bses_[A-Za-z0-9]{3,64}\b/g;
    return lines.filter((line) => {
        const parsed = parseLogLine(line);
        if (parsed?.session && parsed.session !== sessionId) return false;
        const matches =
            parsed?.message.match(otherSessionPattern) ?? line.match(otherSessionPattern);
        if (!matches) return true;
        return matches.every((id) => id === sessionId);
    });
}

/** Return session IDs in most-recent-first order for an issue-report picker. */
export function getLogSessionIds(lines: string[]): string[] {
    const otherSessionPattern = /\bses_[A-Za-z0-9]{3,64}\b/g;
    const seen = new Set<string>();
    const sessions: string[] = [];
    for (let index = lines.length - 1; index >= 0; index -= 1) {
        const line = lines[index];
        const parsed = parseLogLine(line);
        if (parsed?.session && !seen.has(parsed.session)) {
            seen.add(parsed.session);
            sessions.push(parsed.session);
        }
        const matches =
            parsed?.message.match(otherSessionPattern) ?? line.match(otherSessionPattern);
        for (const session of matches ?? []) {
            if (!seen.has(session)) {
                seen.add(session);
                sessions.push(session);
            }
        }
    }
    return sessions;
}

/**
 * Apply a byte budget to a rendered issue body. If the body is already
 * within budget, returns it unchanged. Otherwise rewrites the main
 * fenced log block (whose heading must start with `## Log (last`) to
 * drop oldest log lines until the body fits, leaving a clear
 * `[truncated for GitHub 64KB limit]` marker at the top of the kept
 * slice.
 *
 * This deliberately ONLY touches the main-log section — the diagnostics,
 * configuration, historian failure signals, and recent-errors sections
 * are preserved intact because they're the most useful parts of the
 * report. The main log is the noise-heavy one and the right thing to
 * shrink first.
 *
 * Returns the (possibly-shrunk) body. UTF-8 byte length is the budget,
 * matching how GitHub measures issue bodies (the issue API rejects
 * `body` payloads above the limit).
 */
export function capBodyToGithubLimit(
    body: string,
    maxBytes: number = MAX_GITHUB_BODY_BYTES,
): string {
    if (Buffer.byteLength(body, "utf8") <= maxBytes) return body;

    let capped = body;

    // Find the main log fence (we use a stable heading that the bundlers
    // always emit below). We don't search for the closing ``` directly
    // because there are several fenced blocks; instead we anchor on the
    // heading line and assume the fence pair is the next ``` / ``` after
    // it (the bundler's structure guarantees this).
    const heading = "## Log (last";
    const headingIdx = body.indexOf(heading);
    if (headingIdx === -1) {
        const markerBytes = Buffer.byteLength(FALLBACK_TRUNCATION_MARKER, "utf8");
        capped = truncateToByteBudget(body, maxBytes - markerBytes) + FALLBACK_TRUNCATION_MARKER;
        return enforceFinalBodyLimit(capped, maxBytes);
    }

    const fenceOpenIdx = body.indexOf("\n```", headingIdx);
    if (fenceOpenIdx === -1) return enforceFinalBodyLimit(body, maxBytes);
    const logStart = fenceOpenIdx + "\n```\n".length;
    const fenceCloseIdx = body.indexOf("\n```", logStart);
    if (fenceCloseIdx === -1) return enforceFinalBodyLimit(body, maxBytes);

    const head = body.slice(0, logStart);
    const log = body.slice(logStart, fenceCloseIdx);
    const tail = body.slice(fenceCloseIdx);

    const overheadBytes = Buffer.byteLength(head, "utf8") + Buffer.byteLength(tail, "utf8");
    const markerBytes = Buffer.byteLength(LOG_TRUNCATION_MARKER, "utf8");
    const logBudget = maxBytes - overheadBytes - markerBytes;
    if (logBudget <= 0) {
        capped = `${head}${LOG_TRUNCATION_MARKER}${tail}`;
        return enforceFinalBodyLimit(capped, maxBytes);
    }

    // Drop oldest lines (from the top) until what's left fits the budget.
    // We split on newlines to preserve line boundaries; binary truncation
    // would corrupt the final line.
    const lines = log.split("\n");
    let keepLines = lines;
    let kept = keepLines.join("\n");
    while (Buffer.byteLength(kept, "utf8") > logBudget && keepLines.length > 1) {
        // Drop ~5% from the top each iteration for fast convergence on
        // very-oversized inputs. Caps at "drop at least one line".
        const dropCount = Math.max(1, Math.floor(keepLines.length * 0.05));
        keepLines = keepLines.slice(dropCount);
        kept = keepLines.join("\n");
    }
    // Final defensive byte-truncation in case a single huge line still
    // overshoots (e.g. one log line that itself exceeds the budget).
    if (Buffer.byteLength(kept, "utf8") > logBudget) {
        kept = truncateToByteBudget(kept, logBudget);
    }

    capped = `${head}${LOG_TRUNCATION_MARKER}${kept}${tail}`;
    return enforceFinalBodyLimit(capped, maxBytes);
}

function enforceFinalBodyLimit(body: string, maxBytes: number): string {
    if (Buffer.byteLength(body, "utf8") <= maxBytes) return body;
    const markerBytes = Buffer.byteLength(FINAL_TRUNCATION_MARKER, "utf8");
    if (markerBytes >= maxBytes) {
        return truncateToByteBudget(FINAL_TRUNCATION_MARKER, maxBytes);
    }
    return truncateToByteBudget(body, maxBytes - markerBytes) + FINAL_TRUNCATION_MARKER;
}

/**
 * Truncate a string to at most `maxBytes` UTF-8 bytes WITHOUT splitting a
 * multi-byte code point. Naive `Buffer.subarray(...).toString("utf8")`
 * replaces any partial codepoint at the cut with U+FFFD (3 bytes), which
 * paradoxically pushes the output OVER the requested budget when the cut
 * happens mid-character.
 *
 * Approach: take the raw byte slice, then walk back from the end until the
 * trailing byte is a UTF-8 start byte (`0xxxxxxx` or `11xxxxxx`). Drop any
 * leading-byte position whose codepoint can't be completed within the
 * budget. This always lands on a clean codepoint boundary and never grows
 * the output past `maxBytes`.
 */
function truncateToByteBudget(input: string, maxBytes: number): string {
    if (maxBytes <= 0) return "";
    const buf = Buffer.from(input, "utf8");
    if (buf.length <= maxBytes) return input;
    let end = maxBytes;
    // Walk back to the nearest UTF-8 codepoint boundary. UTF-8 continuation
    // bytes are 10xxxxxx; start bytes are 0xxxxxxx or 11xxxxxx.
    while (end > 0 && (buf[end] & 0b1100_0000) === 0b1000_0000) {
        end -= 1;
    }
    return buf.subarray(0, end).toString("utf8");
}
