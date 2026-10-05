/**
 * Deterministic rule-based text compression in the style of caveman-speak.
 *
 * Inspired by the caveman Claude Code skill (JuliusBrussee/caveman, 40k stars)
 * which validated telegraph-style compression as the right LLM-friendly
 * compression style — backed by research showing brevity constraints can
 * actually improve LLM accuracy (arxiv 2604.00025, March 2026).
 *
 * This module is pure and stateless. It takes text, applies progressively
 * aggressive rule-based transformations by level, and returns the compressed
 * output. It is used by the compressor to post-process historian output at
 * depths 2-4, enforcing style consistency without relying on LLM compliance.
 *
 * Preservation guarantees (all levels):
 *  - Code blocks (` and ``` fenced)
 *  - URLs (http://, https://)
 *  - File paths (contain / or start with ./ or ../)
 *  - Commit hashes (7-40 hex chars at word boundaries)
 *  - Compartment markers (§N§, U: lines, msg_*, ses_*, toolu_*)
 *  - Lines starting with "U: " (user quotes — irreplaceable phrasing)
 *
 * Compression by level:
 *  - lite   (depth 2): drops filler words and hedging
 *  - full   (depth 3): lite + drops articles and most auxiliaries, allows fragments
 *  - ultra  (depth 4): full + symbol connectives and common-term abbreviation
 *
 * Two rule sets exist (see `CavemanRules`): the current Unicode-aware one, and
 * the original ASCII one, kept so a session already served under it replays the
 * same bytes until a cache-rebuilding pass switches it.
 */

import { isValidLanguageCode } from "../../agents/language-directive";

export type CavemanLevel = "lite" | "full" | "ultra";

// ---------------------------------------------------------------------------
// Preservation: detect regions that must pass through untouched.
// ---------------------------------------------------------------------------

interface PreservedRegion {
    placeholder: string;
    original: string;
}

/** Matches things that must never be modified, applied in this order. After
 *  them come the opencode IDs, the file paths (`findFilePathMatches`) and the
 *  commit hashes, in that order (see protectRegions). */
const PRESERVATION_PATTERNS_BEFORE_PATHS: RegExp[] = [
    // Fenced code blocks (``` ... ```)
    /```[\s\S]*?```/g,
    // Inline code (` ... `)
    /`[^`\n]+`/g,
    // URLs
    /https?:\/\/\S+/g,
    // Magic Context tags
    /§\d+§/g,
];

/** Opencode IDs under the ASCII rules, protected right after the tags. */
const ASCII_IDENTIFIER_PATTERN = /\b(?:msg|ses|toolu)_[A-Za-z0-9]+/g;

/** Commit hashes (7-40 hex) not touching another letter or digit. */
const COMMIT_HASH_PATTERN = /(?<![a-z0-9])[0-9a-f]{7,40}(?![a-z0-9])/gi;

const PLACEHOLDER_OPEN = "\u0000MC_PRES_";

/** A character the file-path heuristic accepts inside a path segment: `[\w.-]`. */
function isPathSegmentCode(code: number): boolean {
    return isAsciiWordCode(code) || code === 46 /* . */ || code === 45 /* - */;
}

/** JavaScript's non-Unicode `\w`: `[A-Za-z0-9_]`. */
function isAsciiWordCode(code: number): boolean {
    return (
        (code >= 48 && code <= 57) ||
        (code >= 65 && code <= 90) ||
        (code >= 97 && code <= 122) ||
        code === 95
    );
}

/** End of the file-name tail `[\w.-]+\.\w{1,6}` that a backtracking engine
 *  picks inside the segment `[start, end)`: the rightmost dot that has at least
 *  one segment character before it and a word character after it, followed by
 *  up to six word characters. Returns -1 when the segment has no such dot. */
function fileNameTailEnd(text: string, start: number, end: number): number {
    for (let dot = end - 2; dot > start; dot -= 1) {
        if (text.charCodeAt(dot) !== 46 || !isAsciiWordCode(text.charCodeAt(dot + 1))) continue;
        let tailEnd = dot + 1;
        while (tailEnd < end && tailEnd - dot <= 6 && isAsciiWordCode(text.charCodeAt(tailEnd))) {
            tailEnd += 1;
        }
        return tailEnd;
    }
    return -1;
}

/**
 * Find the matches of `/(?:\.{1,2}\/)?(?:[\w.-]+\/)+[\w.-]+\.\w{1,6}/g` in
 * linear time, as `[start, end)` pairs in order.
 *
 * Running that regex directly is quadratic: from every position inside a long
 * run of `[\w.-]` characters with no `/`, the engine scans to the end of the
 * run before failing, and the transform replays compression on every pass.
 *
 * The matches are the same as the regex's. Since `.` is itself a segment
 * character, the optional `./` or `../` prefix never changes a match. A match
 * is a chain of segments joined by single slashes, starting at the first
 * segment, and ends in the file-name tail of the LAST segment (after the
 * first) that has one, because the regex takes as many `segment/` repetitions
 * as it can and backtracks from there. A start inside a segment sees the same
 * chain and the same tails as the segment's start, so once a chain has been
 * decided no later start inside it can match, and scanning resumes after it.
 */
export function findFilePathMatches(text: string): Array<[number, number]> {
    const matches: Array<[number, number]> = [];
    const length = text.length;
    let position = 0;
    while (position < length) {
        if (!isPathSegmentCode(text.charCodeAt(position))) {
            position += 1;
            continue;
        }
        const segments: Array<[number, number]> = [];
        let segmentStart = position;
        for (;;) {
            let segmentEnd = segmentStart;
            while (segmentEnd < length && isPathSegmentCode(text.charCodeAt(segmentEnd))) {
                segmentEnd += 1;
            }
            segments.push([segmentStart, segmentEnd]);
            if (
                segmentEnd + 1 < length &&
                text.charCodeAt(segmentEnd) === 47 /* / */ &&
                isPathSegmentCode(text.charCodeAt(segmentEnd + 1))
            ) {
                segmentStart = segmentEnd + 1;
                continue;
            }
            break;
        }
        for (let index = segments.length - 1; index >= 1; index -= 1) {
            const tailEnd = fileNameTailEnd(text, segments[index][0], segments[index][1]);
            if (tailEnd >= 0) {
                matches.push([position, tailEnd]);
                break;
            }
        }
        position = segments[segments.length - 1][1];
    }
    return matches;
}

/** Replace preserved regions with sentinel placeholders so text transforms
 *  can run without damaging them. Returns the rewritten text and the list of
 *  placeholders to restore afterward. */
function protectRegions(
    text: string,
    identifierPattern: RegExp,
): { text: string; preserved: PreservedRegion[] } {
    const preserved: PreservedRegion[] = [];
    const placeholderFor = (original: string): string => {
        const placeholder = `\u0000MC_PRES_${preserved.length}\u0000`;
        preserved.push({ placeholder, original });
        return placeholder;
    };
    let working = text;

    for (const pattern of PRESERVATION_PATTERNS_BEFORE_PATHS) {
        working = working.replace(pattern, (match) => placeholderFor(match));
    }
    // Opencode IDs (msg_*, ses_*, toolu_*).
    working = working.replace(identifierPattern, (match) => placeholderFor(match));

    // File paths: starts with ./ or ../ or contains / and a common file extension.
    const pathMatches = findFilePathMatches(working);
    if (pathMatches.length > 0) {
        let rebuilt = "";
        let cursor = 0;
        for (const [start, end] of pathMatches) {
            rebuilt += working.slice(cursor, start) + placeholderFor(working.slice(start, end));
            cursor = end;
        }
        working = rebuilt + working.slice(cursor);
    }

    working = working.replace(COMMIT_HASH_PATTERN, (match) => placeholderFor(match));

    return { text: working, preserved };
}

/** Restore placeholders to their original content.
 *
 *  A preserved region can contain placeholders of regions protected before it
 *  (a URL that swallowed inline code), never of later ones, so expanding each
 *  placeholder recursively in one pass gives the same text as replacing them
 *  one region at a time from the last to the first, without rescanning the
 *  whole text once per region. That holds only while every NUL in the text
 *  belongs to a placeholder; a source that already contains NUL characters
 *  takes the region-at-a-time path so its output stays byte-identical. */
function restoreRegions(text: string, preserved: PreservedRegion[], sourceHasNul: boolean): string {
    if (preserved.length === 0) return text;
    if (sourceHasNul) {
        let working = text;
        for (let i = preserved.length - 1; i >= 0; i--) {
            working = working.split(preserved[i].placeholder).join(preserved[i].original);
        }
        return working;
    }
    const expanded = new Map<number, string>();
    const expand = (value: string): string => {
        let output = "";
        let cursor = 0;
        for (;;) {
            const start = value.indexOf(PLACEHOLDER_OPEN, cursor);
            if (start < 0) break;
            let end = start + PLACEHOLDER_OPEN.length;
            while (
                end < value.length &&
                value.charCodeAt(end) >= 48 &&
                value.charCodeAt(end) <= 57
            ) {
                end += 1;
            }
            const regionIndex = Number(value.slice(start + PLACEHOLDER_OPEN.length, end));
            const region = preserved[regionIndex];
            if (end === start + PLACEHOLDER_OPEN.length || value.charCodeAt(end) !== 0 || !region) {
                output += value.slice(cursor, start + 1);
                cursor = start + 1;
                continue;
            }
            let restored = expanded.get(regionIndex);
            if (restored === undefined) {
                restored = expand(region.original);
                expanded.set(regionIndex, restored);
            }
            output += value.slice(cursor, start) + restored;
            cursor = end + 1;
        }
        return output + value.slice(cursor);
    };
    return expand(text);
}

// ---------------------------------------------------------------------------
// Wordlists (all compared case-insensitively against word boundaries).
// ---------------------------------------------------------------------------

const FILLER_WORDS = [
    "just",
    "really",
    "basically",
    "actually",
    "essentially",
    "simply",
    "clearly",
    "obviously",
    "quite",
    "very",
    "somewhat",
    "rather",
    "fairly",
    "sort of",
    "kind of",
    "a bit",
];

const HEDGING_PHRASES = [
    "i think",
    "i believe",
    "i feel",
    "probably",
    "perhaps",
    "maybe",
    "it seems",
    "it appears",
    "arguably",
    "i suppose",
    "i guess",
];

const PLEASANTRIES = ["please", "thanks", "thank you", "kindly", "if possible"];

/** Auxiliary verbs we drop when they appear in non-essential positions.
 *  We only drop them between a subject noun and a participle/verb, where
 *  dropping changes tense but preserves meaning enough for a terse summary. */
const AUXILIARIES = [
    "was",
    "were",
    "is",
    "are",
    "am",
    "be",
    "been",
    "being",
    "has been",
    "had been",
    "have been",
    "will be",
    "would be",
    "could be",
    "should be",
    "might be",
    "may be",
];

/** Phrase replacements — always applied at lite+ to shorten common verbose forms. */
const PHRASE_SHORTENINGS: Array<[RegExp, string]> = [
    [/\bin order to\b/gi, "to"],
    [/\bdue to the fact that\b/gi, "because"],
    [/\bat this point in time\b/gi, "now"],
    [/\bat the moment\b/gi, "now"],
    [/\bin the event that\b/gi, "if"],
    [/\bfor the purpose of\b/gi, "for"],
    [/\bwith regard to\b/gi, "about"],
    [/\bin spite of the fact that\b/gi, "though"],
    [/\bon the grounds that\b/gi, "because"],
    [/\bfor the reason that\b/gi, "because"],
];

/** Symbol connectives for ultra level.
 *  Ordered longest-first so ", and then" gets replaced before ", then". */
const ULTRA_CONNECTIVE_REPLACEMENTS: Array<[RegExp, string]> = [
    [/\b(?:and then|then after|afterwards)\b/gi, "→"],
    [/\bbecause of\b/gi, "//"],
    [/\btherefore\b/gi, "→"],
    [/\bbecause\b/gi, "//"],
    [/\bhowever\b/gi, "but"],
    [/\bfurthermore\b/gi, "+"],
    [/\badditionally\b/gi, "+"],
    [/\bas well as\b/gi, "+"],
    // Word-boundary " and " / " or " in prose — not inside identifiers.
    // Leading + trailing space ensures we don't touch "stand" or "word".
    [/ and /gi, " + "],
    [/ or /gi, " | "],
];

/** Abbreviate common repeat terms at ultra level when a single region uses them
 *  3+ times. Applied per-region, not globally, so one-off uses stay readable. */
const ULTRA_ABBREVIATIONS: Record<string, string> = {
    historian: "hist",
    compartment: "cmpt",
    compartments: "cmpts",
    compressor: "cmp",
    compression: "cmp",
    context: "ctx",
    message: "msg",
    messages: "msgs",
    session: "ses",
    configuration: "cfg",
    config: "cfg",
    implementation: "impl",
    implemented: "impl",
    repository: "repo",
    database: "db",
    directory: "dir",
};

// ---------------------------------------------------------------------------
// Transformation helpers.
// ---------------------------------------------------------------------------

/** Build a regex matching any exact phrase from `phrases` as a whole-word match
 *  anywhere in text, case-insensitive, allowing optional leading space (not at
 *  start of line) so we can eat the space after removal and avoid double-spaces.
 *
 *  The leading whitespace may only start where a whitespace run starts. A start
 *  inside the run reaches the same phrase (or the same miss), so this changes
 *  no match, but without it every position of a long run rescans the rest of
 *  the run, which is quadratic. */
function buildPhraseDropRegex(phrases: string[]): RegExp {
    const escaped = phrases.map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    // Match: optional leading space + phrase + word boundary, case-insensitive
    return new RegExp(`(?:(?<!\\s)\\s+)?\\b(?:${escaped.join("|")})\\b`, "gi");
}

function dropPhrases(text: string, phrases: string[]): string {
    return text.replace(buildPhraseDropRegex(phrases), "");
}

/** Drop articles but keep them if they follow a preposition that needs them
 *  for grammatical sense in fragments. Applies a simple rule: drop all unless
 *  immediately after specific disambiguators. Heuristic, good enough for the
 *  already-compressed historian prose we operate on. */
function dropArticles(text: string): string {
    // Match " the ", " a ", " an " (with leading space) and replace with single space.
    // Also match at start of line: "The X" → "X".
    let working = text.replace(/\b(?:the|a|an)\b\s+/gi, "");
    // Collapse resulting multiple spaces.
    working = working.replace(/ +/g, " ");
    return working;
}

/** Drop auxiliary verbs in simple Subject-Aux-Verb patterns.
 *  Example: "historian was compressed" → "historian compressed"
 *  We only match " <AUX> <verb-like-token>" to avoid changing "was" as a
 *  standalone past-tense main verb in sentences like "X was complex".  */
function dropAuxiliaries(text: string): string {
    // Sort longest-first so "has been" matches before "has".
    const sorted = [...AUXILIARIES].sort((a, b) => b.length - a.length);
    const escaped = sorted.map((a) => a.replace(/\s+/g, "\\s+"));
    const pattern = new RegExp(
        // Space + aux + space + (gerund or past participle or verb-like word)
        // Participle heuristic: word ending in -ed, -en, -ing, or a common irregular.
        // The leading run starts only where whitespace starts, for the same
        // reason as in buildPhraseDropRegex.
        `(?<!\\s)\\s+\\b(?:${escaped.join("|")})\\b\\s+(?=\\w+(?:ed|en|ing|ized|ised)\\b)`,
        "gi",
    );
    let working = text.replace(pattern, " ");
    working = working.replace(/ +/g, " ");
    return working;
}

function applyPhraseShortenings(text: string): string {
    let working = text;
    for (const [pattern, replacement] of PHRASE_SHORTENINGS) {
        working = working.replace(pattern, replacement);
    }
    return working;
}

function applyUltraConnectives(text: string): string {
    let working = text;
    for (const [pattern, replacement] of ULTRA_CONNECTIVE_REPLACEMENTS) {
        working = working.replace(pattern, replacement);
    }
    return working;
}

/** Count case-insensitive occurrences of `term` as a whole word in `text`. */
function countWordOccurrences(text: string, term: string): number {
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const matches = text.match(new RegExp(`\\b${escaped}\\b`, "gi"));
    return matches ? matches.length : 0;
}

function applyUltraAbbreviations(text: string): string {
    let working = text;
    for (const [term, abbreviation] of Object.entries(ULTRA_ABBREVIATIONS)) {
        if (countWordOccurrences(working, term) < 3) continue;
        const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        working = working.replace(new RegExp(`\\b${escaped}\\b`, "gi"), (match) => {
            // Preserve first-letter capitalization.
            return match[0] === match[0].toUpperCase()
                ? abbreviation[0].toUpperCase() + abbreviation.slice(1)
                : abbreviation;
        });
    }
    return working;
}

/** Preserve every line that starts with "U: " verbatim. Splits text into U:
 *  and non-U: chunks, applies the transform to non-U: chunks only. */
function transformPreservingUserLines(text: string, transform: (chunk: string) => string): string {
    const lines = text.split("\n");
    const output: string[] = [];
    let buffer: string[] = [];

    const flushBuffer = () => {
        if (buffer.length === 0) return;
        const joined = buffer.join("\n");
        output.push(transform(joined));
        buffer = [];
    };

    for (const line of lines) {
        if (line.startsWith("U: ")) {
            flushBuffer();
            output.push(line);
        } else {
            buffer.push(line);
        }
    }
    flushBuffer();

    return output.join("\n");
}

/** Normalize whitespace: collapse multiple spaces to single, trim line ends,
 *  remove excess blank lines (max one consecutive). */
function normalizeWhitespace(text: string): string {
    return text
        .split("\n")
        .map((line) => line.replace(/[ \t]+/g, " ").replace(/[ \t]+$/, ""))
        .join("\n")
        .replace(/\n{3,}/g, "\n\n");
}

// ---------------------------------------------------------------------------
// Unicode rules ("unicode-v2").
//
// The ASCII rules above treat every non-ASCII letter as a word boundary, so the
// final "a" of "día" reads as the English article and "día para" becomes
// "dípara". These rules count letters, combining marks, numbers and "_" of any
// script as word characters. They also never consume a line break: dropping a
// word at the start of a line used to eat the newline before it and glue the
// line onto the previous one. Patterns use the `u` flag without `i`, and spell
// out ASCII case variants instead, because `iu` would also fold "ſ" to "s"
// and the Kelvin sign to "k", which the Rust port does not do.
// ---------------------------------------------------------------------------

const WORD_CHARS = "\\p{L}\\p{M}\\p{N}_";
/** A word starts here: the previous character is not a word character. */
const NOT_AFTER_WORD = `(?<![${WORD_CHARS}])`;
/** A word ends here: the next character is not a word character. */
const NOT_BEFORE_WORD = `(?![${WORD_CHARS}])`;
/** JavaScript `\s` without the line feed. */
const HORIZONTAL_SPACE = "[^\\S\\n]";

function escapeRegex(literal: string): string {
    return literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Match `literal` with either case of each ASCII letter; `separator`, when
 *  given, replaces each space between words. */
function asciiCaseInsensitive(literal: string, separator?: string): string {
    let pattern = "";
    for (const ch of literal) {
        if (separator !== undefined && ch === " ") pattern += separator;
        else if (/[a-z]/i.test(ch)) pattern += `[${ch.toLowerCase()}${ch.toUpperCase()}]`;
        else pattern += escapeRegex(ch);
    }
    return pattern;
}

function unicodeWordPattern(words: string[], separator?: string): string {
    const alternation = words.map((word) => asciiCaseInsensitive(word, separator)).join("|");
    return `${NOT_AFTER_WORD}(?:${alternation})${NOT_BEFORE_WORD}`;
}

const UNICODE_IDENTIFIER_PATTERN = new RegExp(
    `${NOT_AFTER_WORD}(?:msg|ses|toolu)_[A-Za-z0-9]+`,
    "gu",
);

/**
 * Drop every phrase of a list without merging lines. In order of preference at
 * each position:
 *  - at the start of a line: keep the indentation and drop the phrases there
 *    together with the spaces after each, so "Probably the tests" on its own
 *    line becomes "the tests", not " the tests" or a line glued to the last;
 *  - after spaces: drop the spaces and the phrase;
 *  - anywhere else (after punctuation): drop just the phrase.
 * The spaces-then-phrase branch only starts where a run of spaces starts, which
 * keeps long runs linear.
 */
function buildUnicodePhraseDropRegex(phrases: string[]): RegExp {
    const phrase = unicodeWordPattern(phrases);
    return new RegExp(
        `(?<=^|\\n)(${HORIZONTAL_SPACE}*)(?:${phrase}${HORIZONTAL_SPACE}*)+` +
            `|(?<!${HORIZONTAL_SPACE})${HORIZONTAL_SPACE}+${phrase}` +
            `|${phrase}`,
        "gu",
    );
}

const UNICODE_FILLER_DROP = buildUnicodePhraseDropRegex(FILLER_WORDS);
const UNICODE_HEDGING_DROP = buildUnicodePhraseDropRegex(HEDGING_PHRASES);
const UNICODE_PLEASANTRY_DROP = buildUnicodePhraseDropRegex(PLEASANTRIES);

function dropPhrasesUnicode(text: string, pattern: RegExp): string {
    return text.replace(pattern, (_match, indentation: string | undefined) => indentation ?? "");
}

const UNICODE_ARTICLE_DROP = new RegExp(
    `${unicodeWordPattern(["the", "a", "an"])}${HORIZONTAL_SPACE}+`,
    "gu",
);

function dropArticlesUnicode(text: string): string {
    return text.replace(UNICODE_ARTICLE_DROP, "").replace(/ +/g, " ");
}

const UNICODE_AUXILIARY_DROP = new RegExp(
    `(?<!${HORIZONTAL_SPACE})${HORIZONTAL_SPACE}+` +
        unicodeWordPattern(
            [...AUXILIARIES].sort((a, b) => b.length - a.length),
            `${HORIZONTAL_SPACE}+`,
        ) +
        `${HORIZONTAL_SPACE}+(?=[${WORD_CHARS}]+(?:${["ed", "en", "ing", "ized", "ised"]
            .map((suffix) => asciiCaseInsensitive(suffix))
            .join("|")})${NOT_BEFORE_WORD})`,
    "gu",
);

function dropAuxiliariesUnicode(text: string): string {
    return text.replace(UNICODE_AUXILIARY_DROP, " ").replace(/ +/g, " ");
}

const UNICODE_PHRASE_SHORTENINGS: Array<[RegExp, string]> = [
    ["in order to", "to"],
    ["due to the fact that", "because"],
    ["at this point in time", "now"],
    ["at the moment", "now"],
    ["in the event that", "if"],
    ["for the purpose of", "for"],
    ["with regard to", "about"],
    ["in spite of the fact that", "though"],
    ["on the grounds that", "because"],
    ["for the reason that", "because"],
].map(([phrase, replacement]) => [new RegExp(unicodeWordPattern([phrase]), "gu"), replacement]);

const UNICODE_ULTRA_CONNECTIVES: Array<[RegExp, string]> = [
    [new RegExp(unicodeWordPattern(["and then", "then after", "afterwards"]), "gu"), "→"],
    [new RegExp(unicodeWordPattern(["because of"]), "gu"), "//"],
    [new RegExp(unicodeWordPattern(["therefore"]), "gu"), "→"],
    [new RegExp(unicodeWordPattern(["because"]), "gu"), "//"],
    [new RegExp(unicodeWordPattern(["however"]), "gu"), "but"],
    [new RegExp(unicodeWordPattern(["furthermore"]), "gu"), "+"],
    [new RegExp(unicodeWordPattern(["additionally"]), "gu"), "+"],
    [new RegExp(unicodeWordPattern(["as well as"]), "gu"), "+"],
    [new RegExp(` ${asciiCaseInsensitive("and")} `, "gu"), " + "],
    [new RegExp(` ${asciiCaseInsensitive("or")} `, "gu"), " | "],
];

const UNICODE_ULTRA_ABBREVIATIONS: Array<[RegExp, string]> = Object.entries(
    ULTRA_ABBREVIATIONS,
).map(([term, abbreviation]) => [new RegExp(unicodeWordPattern([term]), "gu"), abbreviation]);

function applyReplacements(text: string, replacements: Array<[RegExp, string]>): string {
    let working = text;
    for (const [pattern, replacement] of replacements) {
        working = working.replace(pattern, replacement);
    }
    return working;
}

function applyUltraAbbreviationsUnicode(text: string): string {
    let working = text;
    for (const [pattern, abbreviation] of UNICODE_ULTRA_ABBREVIATIONS) {
        if ((working.match(pattern)?.length ?? 0) < 3) continue;
        working = working.replace(pattern, (match) =>
            match[0] === match[0].toUpperCase()
                ? abbreviation[0].toUpperCase() + abbreviation.slice(1)
                : abbreviation,
        );
    }
    return working;
}

// ---------------------------------------------------------------------------
// Public API.
// ---------------------------------------------------------------------------

/**
 * Which rule set compresses the text. Replay recomputes compressed text from the
 * original on every transform pass, so a session keeps the rules it was served
 * until a pass that already rebuilds the provider cache switches it (see
 * caveman-cleanup.ts); changing the rules in place would rewrite served bytes
 * on a pass that must replay them.
 *
 *  - "ascii-v1": ASCII word boundaries; phrase, auxiliary and article drops may
 *    consume a line break; whitespace is normalized after the protected regions
 *    are restored, which collapses indentation inside fenced code.
 *  - "unicode-v2": letters, marks and numbers of any script are word characters;
 *    no rule consumes a line break; protected regions keep their whitespace.
 *    This is the only rule set of the Rust port (crates/mc-module/src/caveman.rs).
 */
export type CavemanRules = "ascii-v1" | "unicode-v2";
export const CURRENT_CAVEMAN_RULES: CavemanRules = "unicode-v2";

/**
 * Whether the current rules may use their English word lists (articles,
 * auxiliaries, fillers, hedges, pleasantries, phrase shortenings, connectives
 * and abbreviations). On other languages those lists rewrite real words
 * ("quite" is Spanish for "remove", "a" is a Spanish preposition), so with
 * "none" only the language-neutral passes run, the same at every level:
 * region protection, whitespace normalization and trimming. The original
 * ASCII rules always use the English lists.
 */
export type CavemanWordRules = "english" | "none";

/**
 * The word rules for the user-level `language` setting: English when it is
 * unset, "en", "en-*", or not a valid code (the same values that produce no
 * language directive); none for any other language. The Rust twin is
 * `caveman_word_rules_for_language` in crates/mc-module/src/transform.rs.
 */
export function cavemanWordRulesForLanguage(language: string | undefined): CavemanWordRules {
    const code = typeof language === "string" ? language.trim().toLowerCase() : "";
    if (code === "en" || code.startsWith("en-")) return "english";
    return isValidLanguageCode(code) ? "none" : "english";
}

/** Compress `text` using caveman-style rules at the given `level`.
 *
 *  Preserved regions (code, URLs, paths, hashes, tag markers, U: lines) are
 *  never modified. Only surrounding prose is transformed.
 *
 *  The function is pure: same input always produces the same output. */
export function cavemanCompress(
    text: string,
    level: CavemanLevel,
    rules: CavemanRules = CURRENT_CAVEMAN_RULES,
    wordRules: CavemanWordRules = "english",
): string {
    if (text.length === 0) return text;
    if (rules === "ascii-v1") return cavemanCompressAsciiV1(text, level);

    const { text: protectedText, preserved } = protectRegions(text, UNICODE_IDENTIFIER_PATTERN);

    const transformed = transformPreservingUserLines(protectedText, (chunk) => {
        let working = chunk;
        if (wordRules === "none") return working;

        working = dropPhrasesUnicode(working, UNICODE_FILLER_DROP);
        working = dropPhrasesUnicode(working, UNICODE_HEDGING_DROP);
        working = dropPhrasesUnicode(working, UNICODE_PLEASANTRY_DROP);
        working = applyReplacements(working, UNICODE_PHRASE_SHORTENINGS);

        if (level === "full" || level === "ultra") {
            working = dropAuxiliariesUnicode(working);
            working = dropArticlesUnicode(working);
        }

        if (level === "ultra") {
            working = applyReplacements(working, UNICODE_ULTRA_CONNECTIVES);
            working = applyUltraAbbreviationsUnicode(working);
        }

        return working;
    });

    // Normalize while the protected regions are still placeholders, so fenced
    // code keeps its indentation. No region starts or ends with whitespace, so
    // trimming here equals trimming the restored text.
    const normalized = normalizeWhitespace(transformed).trim();
    return restoreRegions(normalized, preserved, text.includes("\u0000"));
}

function cavemanCompressAsciiV1(text: string, level: CavemanLevel): string {
    // Protect regions that must never change.
    const { text: protectedText, preserved } = protectRegions(text, ASCII_IDENTIFIER_PATTERN);

    // Apply transforms to non-U:-line chunks only.
    const transformed = transformPreservingUserLines(protectedText, (chunk) => {
        let working = chunk;

        // Lite, Full, Ultra all apply these:
        working = dropPhrases(working, FILLER_WORDS);
        working = dropPhrases(working, HEDGING_PHRASES);
        working = dropPhrases(working, PLEASANTRIES);
        working = applyPhraseShortenings(working);

        if (level === "full" || level === "ultra") {
            working = dropAuxiliaries(working);
            working = dropArticles(working);
        }

        if (level === "ultra") {
            working = applyUltraConnectives(working);
            working = applyUltraAbbreviations(working);
        }

        return working;
    });

    // Restore preserved regions, then normalize whitespace.
    const restored = restoreRegions(transformed, preserved, text.includes("\u0000"));
    return normalizeWhitespace(restored).trim();
}
