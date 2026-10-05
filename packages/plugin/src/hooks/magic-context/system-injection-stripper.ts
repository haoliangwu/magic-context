const SYSTEM_INJECTION_MARKERS = [
    "<!-- OMO_INTERNAL_INITIATOR -->",
    "[SYSTEM DIRECTIVE: MAGIC-CONTEXT",
    "[SYSTEM DIRECTIVE: OH-MY-OPENCODE",
    "[Category+Skill Reminder]",
    "[EDIT ERROR - IMMEDIATE ACTION REQUIRED]",
    "[task CALL FAILED - IMMEDIATE RETRY REQUIRED]",
    "[EMERGENCY CONTEXT WINDOW WARNING]",
    "Unstable background agent appears idle",
    "**THE SUBAGENT JUST CLAIMED THIS TASK IS DONE.",
];

const SYSTEM_REMINDER_REGEX = /<system-reminder>[\s\S]*?<\/system-reminder>/gi;
const OMO_MARKER_REGEX = /<!-- OMO_INTERNAL_INITIATOR -->/g;

/**
 * OpenCode up to 1.17.8 wrapped a user message sent while the agent was still
 * running in this exact reminder before the transform saw it (1.17.9 removed
 * the wrapper). The body is the user's own words, so it must never be treated
 * as an injection: stripping it would empty the message and drop the user's
 * instruction permanently. The trailer anchors the match, so a reminder the
 * user's text itself contains stays inside the preserved block.
 */
const STEERING_WRAPPER_REGEX =
    /<system-reminder>\nThe user sent the following message:\n[\s\S]*?\n\nPlease address this message and continue with your tasks\.\n<\/system-reminder>/g;

export function stripSystemInjection(text: string): string | null {
    STEERING_WRAPPER_REGEX.lastIndex = 0;
    if (!STEERING_WRAPPER_REGEX.test(text)) return stripInjectedRegions(text);
    STEERING_WRAPPER_REGEX.lastIndex = 0;

    // Strip only the text between wrapped user messages; keep each wrapper verbatim.
    let result = "";
    let changed = false;
    let cursor = 0;
    const keepOrStrip = (segment: string): void => {
        const stripped = stripInjectedRegions(segment);
        if (stripped === null) {
            result += segment;
        } else {
            result += stripped;
            changed = true;
        }
    };
    for (const match of text.matchAll(STEERING_WRAPPER_REGEX)) {
        keepOrStrip(text.slice(cursor, match.index));
        result += match[0];
        cursor = match.index + match[0].length;
    }
    keepOrStrip(text.slice(cursor));
    return changed ? result.trim() : null;
}

/**
 * Apply `strip` to the text outside each steering wrapper (see
 * STEERING_WRAPPER_REGEX) and keep every wrapper verbatim. Text with no wrapper
 * is passed to `strip` whole. Readers that drop reminder blocks (the historian
 * chunk reader) use it so a mid-run user message is not lost as noise.
 */
export function stripOutsideSteeringWrappers(
    text: string,
    strip: (segment: string) => string,
): string {
    STEERING_WRAPPER_REGEX.lastIndex = 0;
    let result = "";
    let cursor = 0;
    for (const match of text.matchAll(STEERING_WRAPPER_REGEX)) {
        result += strip(text.slice(cursor, match.index));
        result += match[0];
        cursor = match.index + match[0].length;
    }
    return result + strip(text.slice(cursor));
}

function stripInjectedRegions(text: string): string | null {
    let hasInjection = false;
    for (const marker of SYSTEM_INJECTION_MARKERS) {
        if (text.includes(marker)) {
            hasInjection = true;
            break;
        }
    }
    if (SYSTEM_REMINDER_REGEX.test(text)) hasInjection = true;
    SYSTEM_REMINDER_REGEX.lastIndex = 0;

    if (!hasInjection) return null;

    let cleaned = text;
    cleaned = cleaned.replace(SYSTEM_REMINDER_REGEX, "");
    cleaned = cleaned.replace(OMO_MARKER_REGEX, "");
    cleaned = cleaned.replace(
        /\[SYSTEM DIRECTIVE: OH-MY-(?:OPENCODE|CLAUDE)[^\]]*\][\s\S]*?(?=\n\n(?!\s*[-*])|$)/g,
        "",
    );

    for (const marker of SYSTEM_INJECTION_MARKERS) {
        if (marker.startsWith("<!-- ") || marker.startsWith("[SYSTEM DIRECTIVE")) continue;
        const idx = cleaned.indexOf(marker);
        if (idx === -1) continue;
        const blockEnd = cleaned.indexOf("\n\n", idx + marker.length);
        cleaned =
            blockEnd !== -1
                ? cleaned.slice(0, idx) + cleaned.slice(blockEnd)
                : cleaned.slice(0, idx);
    }

    return cleaned.trim();
}
