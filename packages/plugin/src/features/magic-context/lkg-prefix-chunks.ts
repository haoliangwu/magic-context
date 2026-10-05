import { createHash } from "node:crypto";

/**
 * Layout of a persisted last-known-good (LKG) prefix in `lkg_slot_chunks`.
 *
 * The prefix is the exact JSON string an applied pass served, and it only ever
 * grows by a small append between passes. Storing it as one value made SQLite
 * rewrite the whole multi-megabyte record on every pass, because a record whose
 * length changes is rewritten in full. Fixed-position slices keep an append to
 * the one or two trailing slices that actually changed.
 *
 * The string is cut and concatenated, never re-serialized, so a loaded prefix is
 * byte-for-byte the string that was saved.
 */

/** Size of one stored slice, in UTF-16 code units (JavaScript string length). */
export const LKG_PREFIX_CHUNK_CHARS = 64 * 1024;

/**
 * Cut a prefix into consecutive slices of at most LKG_PREFIX_CHUNK_CHARS. A slice
 * never ends between the two halves of a surrogate pair: SQLite stores TEXT as
 * UTF-8, and a lone half would not survive the round trip. The boundaries depend
 * only on the text before them, so appending to a prefix leaves every earlier
 * slice unchanged.
 */
export function splitLkgPrefix(jsonPrefix: string): string[] {
    const chunks: string[] = [];
    let start = 0;
    while (start < jsonPrefix.length) {
        let end = Math.min(start + LKG_PREFIX_CHUNK_CHARS, jsonPrefix.length);
        if (end < jsonPrefix.length) {
            const last = jsonPrefix.charCodeAt(end - 1);
            if (last >= 0xd800 && last <= 0xdbff) end -= 1;
        }
        chunks.push(jsonPrefix.slice(start, end));
        start = end;
    }
    return chunks;
}

export function hashLkgChunk(body: string): string {
    return createHash("sha256").update(body).digest("hex");
}

/** Hash of the whole prefix, derived from its slice hashes in order. */
export function hashLkgChunkList(chunkHashes: readonly string[]): string {
    return createHash("sha256").update(chunkHashes.join("\n")).digest("hex");
}

export interface LkgPrefixLayout {
    readonly chunks: string[];
    readonly chunkHashes: string[];
    readonly chars: number;
    readonly hash: string;
}

export function layoutLkgPrefix(jsonPrefix: string): LkgPrefixLayout {
    const chunks = splitLkgPrefix(jsonPrefix);
    const chunkHashes = chunks.map(hashLkgChunk);
    return { chunks, chunkHashes, chars: jsonPrefix.length, hash: hashLkgChunkList(chunkHashes) };
}

export interface AssembledLkgPrefix {
    readonly jsonPrefix: string;
    readonly chunkHashes: string[];
    readonly hash: string;
}

/**
 * Rebuild a prefix from its stored slices and check it against the slot row's
 * count, length and hash, and each slice against its own stored hash. Returns
 * undefined on any mismatch: a missing, extra, reordered or partially written
 * slice must never produce a replayable prefix.
 */
export function assembleLkgPrefix(
    expected: { chars: unknown; chunks: unknown; hash: unknown },
    rows: ReadonlyArray<{ chunk?: unknown; hash?: unknown; body?: unknown }>,
): AssembledLkgPrefix | undefined {
    const { chars, chunks, hash } = expected;
    if (
        typeof chars !== "number" ||
        !Number.isSafeInteger(chars) ||
        typeof chunks !== "number" ||
        !Number.isSafeInteger(chunks) ||
        typeof hash !== "string" ||
        rows.length !== chunks
    ) {
        return undefined;
    }
    const bodies: string[] = [];
    let length = 0;
    for (let index = 0; index < rows.length; index += 1) {
        const row = rows[index];
        if (row?.chunk !== index || typeof row.body !== "string") return undefined;
        bodies.push(row.body);
        length += row.body.length;
    }
    if (length !== chars) return undefined;
    const chunkHashes = bodies.map(hashLkgChunk);
    // A slice's stored hash is what the next save compares against, so it must
    // describe the stored body.
    if (chunkHashes.some((chunkHash, index) => rows[index]?.hash !== chunkHash)) return undefined;
    if (hashLkgChunkList(chunkHashes) !== hash) return undefined;
    return { jsonPrefix: bodies.join(""), chunkHashes, hash };
}
