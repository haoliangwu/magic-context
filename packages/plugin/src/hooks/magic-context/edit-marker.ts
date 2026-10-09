// When a file is edited repeatedly, shorten older diffs instead of removing the
// calls entirely. Keeping the path and a short diff prefix lets the assistant
// identify which file and region each older edit affected.
//
// This representation is used only for edit_marker rows on cache-rebuilding
// passes. Do not change the existing truncate() skeleton: it replays on every
// pass, and changing its bytes would invalidate cached prefixes even when this
// behavior is not enabled.
//
// Each rebuild starts from the original wire part, so the result is stable.
// The sentinel also makes applying the marker twice in one pass a no-op.

const TRUNCATION_SENTINEL = "...[truncated]";

/** Region-hint length: enough to identify the edited section, cheap to keep. */
export const EDIT_REGION_HINT_LEN = 40;

/** Argument keys preserved VERBATIM (the file identity the agent needs). */
const PATH_KEYS = new Set(["filePath", "file_path", "path"]);

/** The bulky diff keys clamped to a region hint. `edit` uses oldString/newString;
 * `write` uses content. Snake-case variants tolerated defensively. */
const DIFF_KEYS = new Set(["oldString", "newString", "content", "old_string", "new_string"]);

/** Slice without splitting a surrogate pair (mirrors tool-drop-target's helper;
 * duplicated rather than shared to avoid touching the existing truncate path). */
function safeSlice(str: string, maxLen: number): string {
    if (str.length <= maxLen) return str;
    const lastCharCode = str.charCodeAt(maxLen - 1);
    if (lastCharCode >= 0xd800 && lastCharCode <= 0xdbff) {
        return str.slice(0, maxLen - 1);
    }
    return str.slice(0, maxLen);
}

/** True for the tools whose superseded older calls we compress. */
export function isEditTool(name: string | null | undefined): boolean {
    return name === "edit" || name === "write";
}

/**
 * Mutate a tool input object in place into its edit-marker form: preserve
 * path-like keys verbatim, clamp the diff keys to a region-hint prefix, leave
 * other (small) keys untouched. Idempotent.
 */
export function applyEditMarkerToInput(input: Record<string, unknown>): void {
    for (const key of Object.keys(input)) {
        if (PATH_KEYS.has(key)) continue;
        const value = input[key];
        if (typeof value !== "string" || !DIFF_KEYS.has(key)) continue;
        if (value.endsWith(TRUNCATION_SENTINEL)) continue; // already a hint
        input[key] =
            value.length > EDIT_REGION_HINT_LEN
                ? `${safeSlice(value, EDIT_REGION_HINT_LEN)}${TRUNCATION_SENTINEL}`
                : value;
    }
}
