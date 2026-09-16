import type { ContextDatabase } from "../../features/magic-context/storage";

const TAG_QUERY_CHUNK_SIZE = 900;
const ESTIMATED_CHARACTERS_PER_TOKEN = 3.5;

export type DroppedTokenReduction =
    | {
          tagNumber: number;
          mode: "full" | "truncated" | "edit_marker";
      }
    | {
          tagNumber: number;
          mode: "partial";
          removedCharacters: number;
      };

interface PersistedTagTokenCounts {
    tagNumber: number;
    type: string;
    byteSize: number;
    inputByteSize: number;
    reasoningByteSize: number;
    tokenCount: number | null;
    inputTokenCount: number | null;
    reasoningTokenCount: number | null;
}

function estimateCharacters(characters: number): number {
    return Math.ceil(Math.max(0, characters) / ESTIMATED_CHARACTERS_PER_TOKEN);
}

function persistedCountOrByteEstimate(count: number | null, bytes: number): number {
    return typeof count === "number" && Number.isFinite(count)
        ? Math.max(0, count)
        : estimateCharacters(bytes);
}

function loadPersistedTagTokenCounts(
    db: ContextDatabase,
    sessionId: string,
    tagNumbers: readonly number[],
): Map<number, PersistedTagTokenCounts> {
    const countsByTag = new Map<number, PersistedTagTokenCounts>();
    for (let offset = 0; offset < tagNumbers.length; offset += TAG_QUERY_CHUNK_SIZE) {
        const chunk = tagNumbers.slice(offset, offset + TAG_QUERY_CHUNK_SIZE);
        const placeholders = chunk.map(() => "?").join(",");
        const rows = db
            .prepare(
                `SELECT tag_number AS tagNumber,
                        type,
                        byte_size AS byteSize,
                        input_byte_size AS inputByteSize,
                        reasoning_byte_size AS reasoningByteSize,
                        token_count AS tokenCount,
                        input_token_count AS inputTokenCount,
                        reasoning_token_count AS reasoningTokenCount
                   FROM tags
                  WHERE session_id = ? AND tag_number IN (${placeholders})`,
            )
            .all(sessionId, ...chunk) as PersistedTagTokenCounts[];
        for (const row of rows) countsByTag.set(row.tagNumber, row);
    }
    return countsByTag;
}

/**
 * Estimate the tokens removed by reductions first applied during this pass.
 * Full removals use every persisted token component carried by the tag row.
 * Tool skeletons retain invocation structure, so they count only the persisted
 * output token_count that the skeleton removes. Partial text rewrites cannot
 * derive their removed share from the full persisted count; only their observed
 * removed characters use the same 3.5-characters-per-token fallback as the
 * tokenizer's failure path. The full message array is never serialized here.
 */
export function estimateDroppedTokensFromTagReductions(
    db: ContextDatabase,
    sessionId: string,
    reductions: readonly DroppedTokenReduction[],
): number {
    if (reductions.length === 0) return 0;

    const structuralByTag = new Map<
        number,
        Extract<DroppedTokenReduction, { mode: "full" | "truncated" | "edit_marker" }>
    >();
    const partialCharactersByTag = new Map<number, number>();
    for (const reduction of reductions) {
        if (reduction.mode === "partial") {
            partialCharactersByTag.set(
                reduction.tagNumber,
                (partialCharactersByTag.get(reduction.tagNumber) ?? 0) +
                    Math.max(0, reduction.removedCharacters),
            );
            continue;
        }
        const prior = structuralByTag.get(reduction.tagNumber);
        if (!prior || reduction.mode === "full") {
            structuralByTag.set(reduction.tagNumber, reduction);
        }
    }

    const tagNumbers = [...new Set([...structuralByTag.keys(), ...partialCharactersByTag.keys()])];
    const countsByTag = loadPersistedTagTokenCounts(db, sessionId, tagNumbers);
    let total = 0;

    for (const [tagNumber, reduction] of structuralByTag) {
        const row = countsByTag.get(tagNumber);
        if (!row) continue;
        total += persistedCountOrByteEstimate(row.tokenCount, row.byteSize);
        if (reduction.mode === "full") {
            total += persistedCountOrByteEstimate(row.reasoningTokenCount, row.reasoningByteSize);
            if (row.type === "tool") {
                total += persistedCountOrByteEstimate(row.inputTokenCount, row.inputByteSize);
            }
        }
    }

    for (const [tagNumber, removedCharacters] of partialCharactersByTag) {
        if (structuralByTag.has(tagNumber) || !countsByTag.has(tagNumber)) continue;
        total += estimateCharacters(removedCharacters);
    }

    return Math.max(0, Math.round(total));
}
