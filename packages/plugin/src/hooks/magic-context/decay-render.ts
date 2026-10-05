/**
 * Shared deterministic decay renderer (v2). Used by BOTH OpenCode
 * (inject-compartments.ts) and Pi (inject-compartments-pi.ts) so the two
 * harnesses render compartment history byte-identically from the same validated
 * decay curve. This is the single render-side implementation of the curve in
 * `decay-curve.ts`; neither harness may keep a private/approximate copy.
 *
 * Responsibilities:
 *  - Pick a tier per compartment from age + importance + budget pressure
 *    (decay-curve.ts), with budget pressure computed ONCE per pass.
 *  - Render the chosen paraphrase tier (P1..P4); P5 = archived (omitted).
 *  - Legacy (pre-v2, flat-content) compartments: no paraphrase columns, so the
 *    initial tier is P3 when the body has a `U:` line else P4, and the body is
 *    truncated `content`.
 *  - Demote oldest-first under a hard token budget (the curve already fits the
 *    budget, but this guards against estimate drift / very tight budgets).
 *
 * v2 faithful facts: this renderer NEVER emits a <session_facts> block. Facts
 * are promoted to project memory and render via <project-memory>. Callers pass
 * the memory block separately; session facts are not a render input.
 */

import { isNoContentCompartment } from "../../features/magic-context/no-content-compartment";
import { computeBudgetPressure, renderedTier, TIER_COST, type Tier } from "./decay-curve";
import { estimateTokens } from "./read-session-formatting";

/** Default history budget when a caller doesn't supply one. */
export const DEFAULT_HISTORY_BUDGET_TOKENS = 60_000;

/** Minimal compartment shape the renderer needs (subset of Compartment). */
export interface DecayRenderCompartment {
    startMessage: number;
    endMessage: number;
    title: string;
    content: string;
    startDate?: string | null;
    endDate?: string | null;
    p1?: string | null;
    p2?: string | null;
    p3?: string | null;
    p4?: string | null;
    importance?: number | null;
    legacy?: number | null;
}

function escapeXmlContent(s: string): string {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function formatDateRange(startDate?: string | null, endDate?: string | null): string {
    if (!startDate || !endDate) return "";
    if (startDate === endDate) return startDate;
    if (startDate.slice(0, 7) === endDate.slice(0, 7)) return `${startDate}→${endDate.slice(8)}`;
    return `${startDate}→${endDate}`;
}

function sanitizeCompartmentTitle(title: string): string {
    // Historian-authored titles are untrusted: Cc, line-separator, and paragraph-
    // separator runs must collapse or they can forge a visually multiline heading.
    return escapeXmlContent(title.replace(/[\p{Cc}\p{Zl}\p{Zp}]+/gu, " "));
}

function compartmentHeading(c: DecayRenderCompartment): string {
    const dateRange = formatDateRange(c.startDate, c.endDate);
    const dateSegment = dateRange ? ` · ${dateRange}` : "";
    return `## ${c.startMessage}-${c.endMessage}${dateSegment} · ${sanitizeCompartmentTitle(c.title)}`;
}

function guardCompartmentBody(body: string): string {
    // A rendered body cannot open a new compartment; indent heading-like lines so
    // the next unindented `## ` line remains an unambiguous compartment boundary.
    return body.replace(/^## /gm, " ## ");
}

/**
 * A row is v2-tiered ONLY when `p1` is a non-empty string. This matches the
 * compartment parser's contract (compartment-parser.ts: a row is tiered iff
 * `p1.length > 0`) and the NEEDS_UPGRADE predicate (`legacy=1 OR p1 IS NULL OR
 * p1=''`). Rows with empty/null `p1` — legacy rows, or the malformed pseudo-v2
 * state left by an interrupted upgrade (`legacy=0` but tiers never populated) —
 * must render via flat `content`, never as an empty tier body. Note a VALID v2
 * row can still have an empty `p4` (a legitimate title-only heading); that's
 * handled by the tier-body path, not here, because such a row has a non-empty `p1`.
 */
function isTieredRow(c: DecayRenderCompartment): boolean {
    return typeof c.p1 === "string" && c.p1.length > 0;
}

/** v2 paraphrase tier body with denser-tier and content fallbacks. */
function tierBody(c: DecayRenderCompartment, tier: number): string {
    const tiers = [c.p1, c.p2, c.p3, c.p4];
    const requested = tiers[tier - 1];
    if (typeof requested === "string") return requested.trim();
    for (let i = tier - 2; i >= 0; i--) {
        const t = tiers[i];
        if (typeof t === "string" && t.length > 0) return t.trim();
    }
    return (c.content ?? "").trim();
}

/** Legacy flat-content tier rendering (no paraphrase columns). */
function legacyBodyForTier(content: string, tier: number): string {
    if (tier <= 1) return content;
    if (tier === 2)
        return content.length > 1_200 ? `${content.slice(0, 1_200).trimEnd()}…` : content;
    return content.length > 420 ? `${content.slice(0, 420).trimEnd()}…` : content;
}

/** Legacy compartments start at P3 (has a `U:` line) or P4 (otherwise). */
function legacyTier(c: DecayRenderCompartment): Tier {
    return /^U:/m.test(c.content) ? 3 : 4;
}

/**
 * Render a single compartment at an explicit tier. Exposed for the m[1]
 * "new compartments" block, which always renders newest compartments at P1
 * (full fidelity — no decay applies to brand-new deltas).
 */
export function renderCompartmentAtTier(c: DecayRenderCompartment, tier: number): string {
    return renderOneCompartment(c, tier);
}

function renderOneCompartment(c: DecayRenderCompartment, tier: number): string {
    if (isNoContentCompartment(c) || tier >= 5) return ""; // archived
    const heading = compartmentHeading(c);

    // Legacy rows AND malformed pseudo-v2 rows (legacy=0 but no usable p1, e.g.
    // an interrupted upgrade) render via flat `content` — never as an empty
    // title-only heading. Without this, a `legacy=0, p1=''` row silently drops
    // the compartment body from m[0]/m[1].
    if (c.legacy === 1 || !isTieredRow(c)) {
        const flat = (c.content ?? "").trim();
        if (tier >= 4 || flat.length === 0) return heading;
        const body = guardCompartmentBody(escapeXmlContent(legacyBodyForTier(flat, tier)));
        return `${heading}\n${body}`;
    }

    const body = tierBody(c, tier);
    if (body.length === 0) return heading;
    return `${heading}\n${guardCompartmentBody(escapeXmlContent(body))}`;
}

/**
 * Compute the rendered tier for each compartment, given budget pressure derived
 * once from the whole set. `compartments` are in chronological order (oldest
 * first); the decay curve indexes from newest (1 = newest).
 */
function computeTiers(
    compartments: DecayRenderCompartment[],
    historyBudgetTokens: number,
): number[] {
    const v2Compartments = compartments
        .map((c, originalIndex) => ({ c, originalIndex }))
        .filter(({ c }) => c.legacy !== 1);
    const v2Total = v2Compartments.length;
    const v2IndexByOriginalIndex = new Map<number, number>();

    // Legacy rows are governed by deterministic truncation, not the decay
    // curve. Including them would let non-rendered curve cost from unrelated
    // rows demote v2 paraphrases, breaking budget honesty for mixed sessions.
    const curveInputs = v2Compartments.map(({ c, originalIndex }, v2Ordinal) => {
        const curveIndex = v2Total - v2Ordinal; // 1-based from newest v2 row
        v2IndexByOriginalIndex.set(originalIndex, curveIndex);
        return {
            index: curveIndex,
            importance: Math.max(1, Math.min(100, c.importance ?? 50)),
        };
    });
    const pressure =
        historyBudgetTokens > 0 ? computeBudgetPressure(curveInputs, historyBudgetTokens) : 1;

    return compartments.map((c, index) => {
        if (c.legacy === 1) return legacyTier(c);
        return renderedTier(
            v2IndexByOriginalIndex.get(index) ?? 1,
            c.importance ?? 50,
            pressure,
            0,
        );
    });
}

/**
 * Render the decayed compartment history block. Optionally prefixes a memory
 * block. Never renders session facts (v2 faithful). Returns the joined body
 * (no <session-history> wrapper — callers add their own framing).
 */
export function renderDecayedCompartments(args: {
    compartments: DecayRenderCompartment[];
    /** The caller converts the provider-token history budget to local tokens before rendering. */
    historyBudgetTokens: number;
}): string {
    const { historyBudgetTokens } = args;
    const compartments = args.compartments.filter((c) => !isNoContentCompartment(c));
    if (compartments.length === 0) return "";

    const tiers = computeTiers(compartments, historyBudgetTokens);
    const renderedByTier = compartments.map(() => new Array<string | undefined>(6));
    const tokensByTier = compartments.map(() => new Array<number | undefined>(6));

    const renderedAt = (index: number, tier: number): string => {
        const cached = renderedByTier[index][tier];
        if (cached !== undefined) return cached;
        const rendered = renderOneCompartment(compartments[index], tier);
        renderedByTier[index][tier] = rendered;
        return rendered;
    };
    const tokensAt = (index: number, tier: number): number => {
        const cached = tokensByTier[index][tier];
        if (cached !== undefined) return cached;
        const rendered = renderedAt(index, tier);
        const tokens = rendered.length === 0 ? 0 : estimateTokens(rendered);
        tokensByTier[index][tier] = tokens;
        return tokens;
    };
    const render = (): string => {
        const parts: string[] = [];
        for (let i = 0; i < compartments.length; i++) {
            const rendered = renderedAt(i, tiers[i]);
            if (rendered.length > 0) parts.push(rendered);
        }
        return parts.join("\n\n");
    };

    let body = render();
    if (historyBudgetTokens <= 0) return body;

    // Sum memoized compartment counts while selecting tiers. A final joined-body
    // check below accounts for separators and tokenizer effects at boundaries.
    let runningTokens = 0;
    for (let i = 0; i < tiers.length; i++) {
        runningTokens += tokensAt(i, tiers[i]);
    }

    let guard = compartments.length * 5;
    let oldestDemotableIndex = 0;
    const demoteOldest = (): boolean => {
        while (oldestDemotableIndex < tiers.length && tiers[oldestDemotableIndex] >= 5) {
            oldestDemotableIndex += 1;
        }
        if (oldestDemotableIndex >= tiers.length) return false;

        const index = oldestDemotableIndex;
        const previousTier = tiers[index];
        const nextTier = previousTier + 1;
        runningTokens += tokensAt(index, nextTier) - tokensAt(index, previousTier);
        tiers[index] = nextTier;
        return true;
    };

    while (runningTokens > historyBudgetTokens && guard > 0) {
        if (!demoteOldest()) break;
        guard -= 1;
    }

    body = render();
    let exactTokens = estimateTokens(body);
    while (exactTokens > historyBudgetTokens && guard > 0) {
        if (!demoteOldest()) break;
        guard -= 1;
        body = render();
        exactTokens = estimateTokens(body);
    }
    return body;
}

/**
 * Extract a top-level m[0] block slice (e.g. "session-history", "project-docs",
 * "user-profile") for budget measurement and token attribution. Returns the
 * full `<tag>…</tag>` slice or null. `tag` must be a literal block name (the
 * caller controls it), so the constructed RegExp is safe.
 *
 * Shared so the materialize tightening loop measures ONLY the session-history
 * slice against the history budget (not the whole m[0], which also carries
 * project-docs / user-profile / project-memory — those have their own budgets),
 * and so the sidebar/status token attribution reads the same slices both
 * harnesses actually render.
 */
export function extractM0Block(m0Text: string, tag: string): string | null {
    const m = m0Text.match(new RegExp(`<${tag}>[\\s\\S]*?</${tag}>`));
    return m ? m[0] : null;
}

export { TIER_COST };
