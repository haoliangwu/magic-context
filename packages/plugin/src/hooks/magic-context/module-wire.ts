import * as crypto from "node:crypto";
import {
    getRawSessionStoredMessageCount,
    readRawSessionMessageOrdinalPage,
} from "./read-session-chunk";
import {
    isRawCompactionSummaryInfo,
    type RawMessageOrdinalAnchor,
    type RawMessageParts,
} from "./read-session-raw";
import type { MessageLike } from "./transform-operations";

/** The maximum request page size accepted by the module facade. */
export const SUBC_MAX_FRAME_BODY_BYTES = 64 * 1024 * 1024;
export const MODULE_PAGE_ENVELOPE_HEADROOM_BYTES = 16 * 1024 * 1024;
export const MODULE_PAGE_MAX_BYTES =
    SUBC_MAX_FRAME_BODY_BYTES - MODULE_PAGE_ENVELOPE_HEADROOM_BYTES;
/** Large individual values are split so one message cannot exceed a page. */
export const MODULE_ITEM_CONTINUATION_CHUNK_BYTES = 64 * 1024;
// The module-side reassembler recognizes this continuation envelope for
// authority state sync and live transform requests.
export const MODULE_ITEM_CONTINUATION_KEY = "__shadow_item_continuation";
export const MODULE_ORDINAL_PAGE_SIZE = 500;

export interface ModuleNormalizationRecord {
    kind: "tag_prefix" | "ctx_search_hint" | "summary_message";
    message_id: string | null;
    part_index: number;
    field: string;
    tag_number?: number;
    removed: string;
}

function yieldToEventLoop(): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, 0));
}

function canonicalJson(value: unknown): string {
    if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
    if (value !== null && typeof value === "object") {
        const record = value as Record<string, unknown>;
        return `{${Object.keys(record)
            .sort()
            .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
            .join(",")}}`;
    }
    const encoded = JSON.stringify(value);
    return encoded === undefined ? "null" : encoded;
}

function transformPageDigest(pageContent: Record<string, unknown>): string {
    const wireContent = JSON.parse(JSON.stringify(pageContent)) as Record<string, unknown>;
    return crypto.createHash("sha256").update(canonicalJson(wireContent)).digest("hex");
}

function getMessageId(message: MessageLike): string | null {
    return typeof message.info.id === "string" && message.info.id.length > 0
        ? message.info.id
        : null;
}

function isSyntheticWireMessage(message: MessageLike): boolean {
    if ((message.info as { synthetic?: unknown }).synthetic === true) return true;
    return message.parts.some(
        (part) =>
            part !== null &&
            typeof part === "object" &&
            (part as { synthetic?: unknown }).synthetic === true,
    );
}

/**
 * Resolve OpenCode message ids to the absolute ordinals used by the module.
 * The module and shadow lanes must see the same provisional suffix behavior, so
 * this is shared rather than reimplemented by the authority adapter.
 */
export async function resolveOrdinalsForModule(args: {
    sessionId: string;
    messages: MessageLike[];
    generation: number;
    memoGeneration: number;
    memo: Map<string, number>;
    memoAnchor?: RawMessageOrdinalAnchor | null;
    memoStoredCount?: number | null;
    memoCanonicalCount?: number;
    /** Absolute ordinal immediately before a sliced unresolved tail. */
    provisionalBase?: number;
    /** Test-only seam that bypasses the memo to force an ordinal-page probe on every request. */
    forceProbeForTests?: boolean;
}): Promise<
    | {
          ok: true;
          annotatedInput: unknown[];
          memoGeneration: number;
          memoAnchor: RawMessageOrdinalAnchor | null;
          memoStoredCount: number;
          memoCanonicalCount: number;
          normalizations: ModuleNormalizationRecord[];
      }
    | {
          ok: false;
          reason: "unresolved" | "mismatch";
          messageId?: string;
          messageIndex?: number;
          messageRole?: string;
      }
> {
    const memo = args.memo;
    const generationChanged = args.memoGeneration !== args.generation;
    if (generationChanged) memo.clear();

    let anchor = generationChanged ? null : (args.memoAnchor ?? null);
    let storedCount = generationChanged ? null : (args.memoStoredCount ?? null);
    let canonicalCount = generationChanged ? 0 : (args.memoCanonicalCount ?? 0);

    const normalizations: ModuleNormalizationRecord[] = [];
    const visibleIndexes: number[] = [];
    const visibleMessages = args.messages.filter((message, index) => {
        if (!isRawCompactionSummaryInfo(message.info)) {
            visibleIndexes.push(index);
            return true;
        }
        normalizations.push({
            kind: "summary_message",
            message_id: getMessageId(message),
            part_index: -1,
            field: "input",
            removed: JSON.stringify(message),
        });
        return false;
    });

    // A warm memo is authoritative until a lifecycle invalidation or an unseen wire id.
    // Stable requests therefore avoid both the OpenCode ordinal-page probe and COUNT.
    const memoCoversWire =
        args.forceProbeForTests !== true &&
        storedCount !== null &&
        visibleMessages.every((message) => {
            const messageId = getMessageId(message);
            return messageId !== null && memo.has(messageId);
        });
    if (!memoCoversWire) {
        const priming = storedCount === null;
        if (priming) {
            memo.clear();
            anchor = null;
            canonicalCount = 0;
        }

        const newEntries: Array<ReturnType<typeof readRawSessionMessageOrdinalPage>[number]> = [];
        let pageAnchor = anchor;
        while (true) {
            const page = readRawSessionMessageOrdinalPage(
                args.sessionId,
                pageAnchor,
                MODULE_ORDINAL_PAGE_SIZE,
            );
            if (page.length === 0) break;
            newEntries.push(...page);
            const last = page[page.length - 1];
            pageAnchor = { timeCreated: last.timeCreated, id: last.id };
            if (page.length < MODULE_ORDINAL_PAGE_SIZE) break;
            await yieldToEventLoop();
        }

        const currentStoredCount = getRawSessionStoredMessageCount(args.sessionId);
        const expectedStoredCount = (storedCount ?? 0) + newEntries.length;
        if (currentStoredCount !== expectedStoredCount) {
            memo.clear();
            return { ok: false, reason: "mismatch" };
        }

        for (const entry of newEntries) {
            if (!entry.contributesOrdinal) continue;
            canonicalCount += 1;
            const prior = memo.get(entry.id);
            if (prior !== undefined && prior !== canonicalCount) {
                memo.clear();
                return { ok: false, reason: "mismatch", messageId: entry.id };
            }
            memo.set(entry.id, canonicalCount);
        }
        anchor = pageAnchor;
        storedCount = currentStoredCount;
    }

    // Keep the caller-owned OpenCode objects untouched. A shallow root projection is
    // sufficient because the encoder only reads nested fields; unlike the old JSON clone,
    // this does not walk or duplicate the full message tree on every pass.
    const annotated: Array<Record<string, unknown>> = new Array(visibleMessages.length);
    const resolved: Array<number | undefined> = new Array(annotated.length);
    let firstUnresolved:
        | {
              messageId: string;
              messageIndex: number;
              messageRole: string;
          }
        | undefined;
    for (let index = 0; index < annotated.length; index += 1) {
        const messageId = getMessageId(visibleMessages[index]);
        if (!messageId) {
            return {
                ok: false,
                reason: "unresolved",
                messageIndex: visibleIndexes[index],
                messageRole: visibleMessages[index].info.role ?? "unknown",
            };
        }
        const ordinal = memo.get(messageId);
        if (ordinal === undefined && firstUnresolved === undefined) {
            firstUnresolved = {
                messageId,
                messageIndex: visibleIndexes[index],
                messageRole: visibleMessages[index].info.role ?? "unknown",
            };
        }
        resolved[index] = ordinal;
    }

    /**
     * OpenCode can place an unpersisted synthetic nudge between two persisted
     * messages in one wire snapshot. It is not part of canonical raw history,
     * so it borrows the preceding canonical ordinal instead of consuming a
     * slot. Only explicit synthetic messages get this exception. A genuine
     * persisted-but-unpaged message remains unresolved and is rejected below;
     * the stored-row count and ordinal self-heal checks still catch drift.
     */
    for (let index = 0; index < resolved.length; index += 1) {
        if (resolved[index] !== undefined || !isSyntheticWireMessage(visibleMessages[index])) {
            continue;
        }
        const hasResolvedMessageAfter = resolved
            .slice(index + 1)
            .some((ordinal) => ordinal !== undefined);
        if (!hasResolvedMessageAfter) continue;
        let priorIndex = index - 1;
        while (priorIndex >= 0 && resolved[priorIndex] === undefined) priorIndex -= 1;
        resolved[index] = priorIndex >= 0 ? (resolved[priorIndex] as number) : 0;
    }

    let suffixStart = annotated.length;
    while (suffixStart > 0 && resolved[suffixStart - 1] === undefined) suffixStart -= 1;
    for (let index = 0; index < suffixStart; index += 1) {
        if (resolved[index] === undefined) {
            return { ok: false, reason: "unresolved", ...firstUnresolved };
        }
    }
    if (suffixStart < annotated.length) {
        const base =
            suffixStart > 0
                ? (resolved[suffixStart - 1] as number)
                : Math.max(0, args.provisionalBase ?? canonicalCount);
        for (let index = suffixStart; index < annotated.length; index += 1) {
            resolved[index] = base + (index - suffixStart) + 1;
        }
    }

    for (let index = 0; index < annotated.length; index += 1) {
        const messageId = getMessageId(visibleMessages[index]) as string;
        const ordinal = resolved[index] as number;
        const prior = memo.get(messageId);
        if (prior !== undefined && prior !== ordinal) {
            return {
                ok: false,
                reason: "mismatch",
                messageId,
                messageIndex: visibleIndexes[index],
                messageRole: visibleMessages[index].info.role ?? "unknown",
            };
        }
        memo.set(messageId, ordinal);
        annotated[index] = { ...visibleMessages[index], absolute_ordinal: ordinal };
    }

    return {
        ok: true,
        annotatedInput: annotated,
        memoGeneration: args.generation,
        memoAnchor: anchor,
        memoStoredCount: storedCount ?? 0,
        memoCanonicalCount: canonicalCount,
        normalizations,
    };
}

/** Flatten the typed builder shape to the module's top-level wire envelope. */
export function toFlatModuleWireBody(payload: {
    method: string;
    params: Record<string, unknown>;
}): Record<string, unknown> {
    return { method: payload.method, ...payload.params };
}

export function moduleWireBodyBytes(payload: {
    method: string;
    params: Record<string, unknown>;
}): number {
    return Buffer.byteLength(JSON.stringify(toFlatModuleWireBody(payload)));
}

/**
 * Page a transform request without changing any message value. Continuation
 * markers are understood by the module and are only used when a single item is
 * larger than the normal page envelope.
 */
export interface ModuleTransformWirePage {
    page: Record<string, unknown>;
    /** UTF-8 byte length of `JSON.stringify(page)`, counted while paging. */
    bytes: number;
}

export function buildPagedModuleTransformPayloads(
    body: Record<string, unknown>,
    pageMaxBytes = MODULE_PAGE_MAX_BYTES,
    forcePageEnvelope = false,
): ModuleTransformWirePage[] {
    // The unpaged path must stringify once to know it fits. Return that length so
    // the transport telemetry does not serialize the same body a second time.
    const serializedBody = JSON.stringify(body);
    const unpagedBytes = Buffer.byteLength(serializedBody);
    if (unpagedBytes <= pageMaxBytes) {
        if (!forcePageEnvelope) return [{ page: body, bytes: unpagedBytes }];
        const pageContent = Object.fromEntries(
            [
                "input",
                "messages",
                "native_messages",
                "ts_output",
                "ts_ck_messages",
                "normalizations",
                "tool_input_key_orders",
            ]
                .filter((field) => {
                    const value = body[field];
                    return (
                        Array.isArray(value) ||
                        (value !== null &&
                            typeof value === "object" &&
                            field === "tool_input_key_orders")
                    );
                })
                .map((field) => [field, body[field]]),
        );
        const page: Record<string, unknown> = {
            transform_page_id: crypto.createHash("sha256").update(serializedBody).digest("hex"),
            transform_generation: body.shadow_generation ?? 0,
            transform_page_index: 0,
            transform_page_total: 1,
            transform_page_complete: true,
            transform_page_digest: transformPageDigest(pageContent),
            ...body,
        };
        return [{ page, bytes: Buffer.byteLength(JSON.stringify(page)) }];
    }

    const arrayFields = [
        "input",
        "messages",
        "native_messages",
        "ts_output",
        "ts_ck_messages",
        "normalizations",
    ].filter((field) => Array.isArray(body[field]));
    const mapFields = ["tool_input_key_orders"].filter((field) => {
        const value = body[field];
        return value !== null && typeof value === "object" && !Array.isArray(value);
    });
    if (arrayFields.length === 0) {
        throw new Error("module transform body has no pageable message arrays");
    }
    const scalarFields = { ...body };
    for (const field of [...arrayFields, ...mapFields]) delete scalarFields[field];
    // A completed series can outlive the requester's route. Content-addressing the
    // attempt lets the next identical cold pass replay page admission and adopt the
    // retained result at the final page instead of rebuilding and executing it.
    const transformPageId = crypto.createHash("sha256").update(serializedBody).digest("hex");
    const arrayItems = arrayFields.flatMap((field) =>
        (body[field] as unknown[]).map((value, itemIndex) => ({ field, value, itemIndex })),
    );
    const mapItems = mapFields.flatMap((field) =>
        Object.entries(body[field] as Record<string, unknown>).map(([key, value]) => ({
            field,
            key,
            value,
        })),
    );
    const emptyArrays = (): Record<string, unknown[]> =>
        Object.fromEntries(arrayFields.map((field) => [field, []]));
    const emptyMaps = (): Record<string, Record<string, unknown>> =>
        Object.fromEntries(
            mapFields.map((field) => [field, Object.create(null) as Record<string, unknown>]),
        );
    const makePage = (args: {
        index: number;
        total: number;
        complete: boolean;
        arrays: Record<string, unknown[]>;
        maps: Record<string, Record<string, unknown>>;
    }): ModuleTransformWirePage => {
        const pageArrays = Object.fromEntries(
            arrayFields.map((field) => [field, args.arrays[field] ?? []]),
        );
        const pageMaps = Object.fromEntries(
            mapFields.map((field) => [field, args.maps[field] ?? {}]),
        );
        const pageContent = { ...pageArrays, ...pageMaps };
        const page: Record<string, unknown> = {
            method: body.method,
            session_id: body.session_id,
            shadow_generation: body.shadow_generation,
            transform_page_id: transformPageId,
            // Authority transforms do not carry a shadow generation. A stable
            // transform generation still belongs to the page envelope so both
            // lanes use the same all-or-none paging contract.
            transform_generation: body.shadow_generation ?? 0,
            transform_page_index: args.index,
            transform_page_total: args.total,
            transform_page_complete: args.complete,
            transform_page_digest: transformPageDigest(pageContent),
            ...pageContent,
        };
        if (args.complete) Object.assign(page, scalarFields);
        // Admission already counted candidate sizes incrementally. Stringify once
        // here so transport telemetry can reuse the exact UTF-8 length.
        return { page, bytes: Buffer.byteLength(JSON.stringify(page)) };
    };
    const hasUnits = (
        arrays: Record<string, unknown[]>,
        maps: Record<string, Record<string, unknown>>,
    ): boolean =>
        Object.values(arrays).some((values) => values.length > 0) ||
        Object.values(maps).some((values) => Object.keys(values).length > 0);

    // Count the wire bytes incrementally so page admission does not clone and
    // canonicalize the growing candidate after every array item or map entry.
    const serializedItemBytes = (value: unknown): number =>
        Buffer.byteLength(JSON.stringify(value) ?? "null");
    const serializedMapEntryBytes = (key: string, value: unknown): number =>
        Buffer.byteLength(JSON.stringify(key)) + 1 + serializedItemBytes(value);
    const scalarTailError = (): Error => {
        const largest = Object.entries(scalarFields)
            .map(([field, value], index) => ({
                field,
                bytes: serializedItemBytes(value),
                index,
            }))
            .sort((left, right) => right.bytes - left.bytes || left.index - right.index)
            .slice(0, 5)
            .map(({ field, bytes }) => `${field}=${bytes} bytes`)
            .join(", ");
        return new Error(
            `module transform scalar tail exceeds the 512 KiB page limit; largest scalar fields: ${largest}`,
        );
    };
    const pageByteLength = (args: {
        index: number;
        total: number;
        complete: boolean;
        arrayBytes: Record<string, number>;
        mapBytes: Record<string, number>;
    }): number => {
        const skeleton: Record<string, unknown> = {
            method: body.method,
            session_id: body.session_id,
            shadow_generation: body.shadow_generation,
            transform_page_id: transformPageId,
            transform_generation: body.shadow_generation ?? 0,
            transform_page_index: args.index,
            transform_page_total: args.total,
            transform_page_complete: args.complete,
            transform_page_digest: "0".repeat(64),
            ...Object.fromEntries(arrayFields.map((field) => [field, []])),
            ...Object.fromEntries(mapFields.map((field) => [field, {}])),
        };
        if (args.complete) Object.assign(skeleton, scalarFields);
        const emptyCollectionBytes = 2 * (arrayFields.length + mapFields.length);
        const contentsBytes =
            arrayFields.reduce((sum, field) => sum + (args.arrayBytes[field] ?? 2), 0) +
            mapFields.reduce((sum, field) => sum + (args.mapBytes[field] ?? 2), 0);
        return Buffer.byteLength(JSON.stringify(skeleton)) - emptyCollectionBytes + contentsBytes;
    };

    let assumedTotal = 1;
    for (let attempt = 0; attempt < 10; attempt += 1) {
        const pages: ModuleTransformWirePage[] = [];
        let currentArrays = emptyArrays();
        let currentMaps = emptyMaps();
        let currentArrayBytes = Object.fromEntries(arrayFields.map((field) => [field, 2]));
        let currentMapBytes = Object.fromEntries(mapFields.map((field) => [field, 2]));
        let currentMapCounts = Object.fromEntries(mapFields.map((field) => [field, 0]));
        const resetCurrent = (): void => {
            currentArrays = emptyArrays();
            currentMaps = emptyMaps();
            currentArrayBytes = Object.fromEntries(arrayFields.map((field) => [field, 2]));
            currentMapBytes = Object.fromEntries(mapFields.map((field) => [field, 2]));
            currentMapCounts = Object.fromEntries(mapFields.map((field) => [field, 0]));
        };
        const flushCurrent = (): void => {
            pages.push(
                makePage({
                    index: pages.length,
                    total: assumedTotal,
                    complete: false,
                    arrays: currentArrays,
                    maps: currentMaps,
                }),
            );
            resetCurrent();
        };
        const currentPageFits = (): boolean =>
            pageByteLength({
                index: pages.length,
                total: assumedTotal,
                complete: false,
                arrayBytes: currentArrayBytes,
                mapBytes: currentMapBytes,
            }) <= pageMaxBytes;
        const appendArrayUnit = (field: string, value: unknown): boolean => {
            const valueBytes = serializedItemBytes(value);
            const previousBytes = currentArrayBytes[field] ?? 2;
            currentArrays[field].push(value);
            currentArrayBytes[field] =
                previousBytes + valueBytes + (currentArrays[field].length > 1 ? 1 : 0);
            if (currentPageFits()) return true;

            currentArrays[field].pop();
            currentArrayBytes[field] = previousBytes;
            if (hasUnits(currentArrays, currentMaps)) flushCurrent();

            currentArrays[field].push(value);
            currentArrayBytes[field] = 2 + valueBytes;
            if (!currentPageFits()) {
                currentArrays[field].pop();
                currentArrayBytes[field] = 2;
                return false;
            }
            return true;
        };
        const appendMapUnit = (field: string, key: string, value: unknown): boolean => {
            const entryBytes = serializedMapEntryBytes(key, value);
            const previousBytes = currentMapBytes[field] ?? 2;
            const previousCount = currentMapCounts[field] ?? 0;
            currentMaps[field][key] = value;
            currentMapCounts[field] = previousCount + 1;
            currentMapBytes[field] = previousBytes + entryBytes + (previousCount > 0 ? 1 : 0);
            if (currentPageFits()) return true;

            delete currentMaps[field][key];
            currentMapCounts[field] = previousCount;
            currentMapBytes[field] = previousBytes;
            if (hasUnits(currentArrays, currentMaps)) flushCurrent();

            currentMaps[field][key] = value;
            currentMapCounts[field] = 1;
            currentMapBytes[field] = 2 + entryBytes;
            if (!currentPageFits()) {
                delete currentMaps[field][key];
                currentMapCounts[field] = 0;
                currentMapBytes[field] = 2;
                return false;
            }
            return true;
        };

        for (const item of arrayItems) {
            if (appendArrayUnit(item.field, item.value)) continue;
            const serialized = JSON.stringify(item.value) ?? "null";
            const bytes = Buffer.from(serialized, "utf8");
            const chunks: string[] = [];
            for (let start = 0; start < bytes.length; ) {
                let end = Math.min(start + MODULE_ITEM_CONTINUATION_CHUNK_BYTES, bytes.length);
                while (end < bytes.length && (bytes[end] & 0xc0) === 0x80) end -= 1;
                chunks.push(bytes.subarray(start, end).toString("utf8"));
                start = end;
            }
            const chunkTotal = chunks.length;
            for (const [chunkIndex, chunk] of chunks.entries()) {
                const marker = {
                    [MODULE_ITEM_CONTINUATION_KEY]: {
                        field: item.field,
                        item_index: item.itemIndex,
                        chunk_index: chunkIndex,
                        chunk_total: chunkTotal,
                    },
                    chunk,
                };
                if (!appendArrayUnit(item.field, marker)) {
                    throw new Error("module transform continuation exceeds the 512 KiB page limit");
                }
            }
        }
        for (const item of mapItems) {
            if (!appendMapUnit(item.field, item.key, item.value)) {
                throw new Error("module transform map entry exceeds the 512 KiB page limit");
            }
        }

        let finalPage = makePage({
            index: pages.length,
            total: assumedTotal,
            complete: true,
            arrays: currentArrays,
            maps: currentMaps,
        });
        if (finalPage.bytes > pageMaxBytes) {
            if (!hasUnits(currentArrays, currentMaps)) throw scalarTailError();
            flushCurrent();
            finalPage = makePage({
                index: pages.length,
                total: assumedTotal,
                complete: true,
                arrays: currentArrays,
                maps: currentMaps,
            });
            if (finalPage.bytes > pageMaxBytes) throw scalarTailError();
        }
        pages.push(finalPage);
        if (pages.length === assumedTotal) return pages;
        assumedTotal = pages.length;
    }
    throw new Error("module transform page count did not stabilize");
}

export interface ModuleRawBlockMapping {
    blockIndex: number;
    partIndex: number;
    kind: "text" | "reasoning" | "file" | "tool_call" | "tool_result" | "other";
    callId?: string;
    toolInput?: unknown;
}

function toolCallId(part: Record<string, unknown>, messageId: string, blockIndex: number): string {
    return (
        (typeof part.callID === "string" && part.callID) ||
        (typeof part.callId === "string" && part.callId) ||
        (typeof part.id === "string" && part.id) ||
        `${messageId}#${blockIndex}`
    );
}

/**
 * Map raw OpenCode parts to the CK block indexes used by the Rust module. The
 * drop seed must name the same block the module would reduce; counting raw
 * parts is not enough because ignored parts disappear and completed tools
 * become a call/result pair.
 */
export function moduleRawBlockMappings(message: RawMessageParts | null): ModuleRawBlockMapping[] {
    if (!message) return [];
    const mappings: ModuleRawBlockMapping[] = [];
    let blockIndex = 0;
    for (const [partIndex, partValue] of message.parts.entries()) {
        if (partValue === null || typeof partValue !== "object" || Array.isArray(partValue))
            continue;
        const part = partValue as Record<string, unknown>;
        const type = typeof part.type === "string" ? part.type : "unknown";
        if (type === "text") {
            if (part.ignored === true) continue;
            mappings.push({ blockIndex, partIndex, kind: "text" });
            blockIndex += 1;
            continue;
        }
        if (["reasoning", "thinking", "redacted_thinking"].includes(type)) {
            mappings.push({ blockIndex, partIndex, kind: "reasoning" });
            blockIndex += 1;
            continue;
        }
        if (type === "tool") {
            const callId = toolCallId(part, message.id, blockIndex);
            const state =
                part.state !== null && typeof part.state === "object" && !Array.isArray(part.state)
                    ? (part.state as Record<string, unknown>)
                    : undefined;
            const input = state?.input ?? part.input ?? part.args ?? {};
            mappings.push({ blockIndex, partIndex, kind: "tool_call", callId, toolInput: input });
            blockIndex += 1;
            if (state?.status === "completed" || state?.status === "error") {
                mappings.push({
                    blockIndex,
                    partIndex,
                    kind: "tool_result",
                    callId,
                    toolInput: input,
                });
                blockIndex += 1;
            }
            continue;
        }
        if (type === "file") {
            mappings.push({ blockIndex, partIndex, kind: "file" });
            blockIndex += 1;
            continue;
        }
        if (["image", "step-start", "subtask"].includes(type)) {
            mappings.push({ blockIndex, partIndex, kind: "other" });
            blockIndex += 1;
            continue;
        }
        if (["compaction", "step-finish", "snapshot", "patch", "agent", "retry"].includes(type)) {
            continue;
        }
        mappings.push({ blockIndex, partIndex, kind: "other" });
        blockIndex += 1;
    }
    return mappings;
}

export const __moduleWireTest = {
    buildPagedModuleTransformPayloads,
    encodeOpenCodeMessagesToCk,
    transformPageDigest,
    moduleRawBlockMappings,
    moduleWireBodyBytes,
    resolveOrdinalsForModule,
    toFlatModuleWireBody,
};

export function encodeOpenCodeMessagesToCk(messages: unknown[]): Array<{
    mid: string;
    ordinal: number;
    ck: Record<string, unknown>;
}> {
    return messages.map((message, index) => {
        const raw =
            message !== null && typeof message === "object"
                ? (message as Record<string, unknown>)
                : {};
        const info =
            raw.info !== null && typeof raw.info === "object"
                ? (raw.info as Record<string, unknown>)
                : raw;
        const id =
            (typeof info.id === "string" && info.id.length > 0 && info.id) ||
            `opencode-${crypto.createHash("sha256").update(JSON.stringify(message)).digest("hex").slice(0, 24)}`;
        const ordinal =
            (typeof raw.absolute_ordinal === "number" && raw.absolute_ordinal) ||
            (typeof info.absolute_ordinal === "number" && info.absolute_ordinal) ||
            index + 1;
        const role = typeof info.role === "string" ? info.role : "user";
        const time =
            info.time !== null && typeof info.time === "object"
                ? (info.time as Record<string, unknown>)
                : {};
        const createdAtMs =
            typeof time.created === "number"
                ? time.created
                : typeof info.time_created === "number"
                  ? info.time_created
                  : typeof info.timeCreated === "number"
                    ? info.timeCreated
                    : undefined;
        const completedAtMs =
            typeof time.completed === "number"
                ? time.completed
                : typeof info.time_completed === "number"
                  ? info.time_completed
                  : typeof info.timeCompleted === "number"
                    ? info.timeCompleted
                    : undefined;
        const parts = Array.isArray(raw.parts) ? raw.parts : [];
        const synthetic =
            parts.length > 0 &&
            parts.every(
                (part) =>
                    part !== null &&
                    typeof part === "object" &&
                    ((part as Record<string, unknown>).synthetic === true ||
                        (part as Record<string, unknown>).syntheticTodoMarker === true),
            );
        const content: Record<string, unknown>[] = [];
        const recoveryToolTitles: Record<string, string> = {};
        for (const partValue of parts) {
            if (partValue === null || typeof partValue !== "object") continue;
            const part = partValue as Record<string, unknown>;
            const type = typeof part.type === "string" ? part.type : "unknown";
            if (type === "text" && part.ignored !== true) {
                content.push({
                    kind: { type: "text", text: typeof part.text === "string" ? part.text : "" },
                });
            } else if (type === "reasoning" || type === "thinking") {
                const signature = typeof part.signature === "string" ? part.signature : undefined;
                content.push({
                    kind: {
                        type: "reasoning",
                        text:
                            typeof part.text === "string"
                                ? part.text
                                : typeof part.thinking === "string"
                                  ? part.thinking
                                  : "",
                        ...(signature ? { signature } : {}),
                    },
                    ...(part.cache_control !== undefined
                        ? {
                              provider_extras: {
                                  opencode: { cache_control: part.cache_control },
                              },
                          }
                        : {}),
                });
            } else if (type === "redacted_thinking") {
                content.push({
                    kind: {
                        type: "redacted_reasoning",
                        data:
                            typeof part.data === "string"
                                ? part.data
                                : typeof part.redacted === "string"
                                  ? part.redacted
                                  : "",
                    },
                    ...(part.cache_control !== undefined
                        ? {
                              provider_extras: {
                                  opencode: { cache_control: part.cache_control },
                              },
                          }
                        : {}),
                });
            } else if (type === "tool") {
                const state =
                    part.state !== null && typeof part.state === "object"
                        ? (part.state as Record<string, unknown>)
                        : {};
                const callId =
                    (typeof part.callID === "string" && part.callID) ||
                    (typeof part.callId === "string" && part.callId) ||
                    (typeof part.id === "string" && part.id) ||
                    `${id}#${content.length}`;
                const toolName = typeof part.tool === "string" ? part.tool : "unknown";
                const input = state.input ?? part.input ?? part.args ?? {};
                content.push({ kind: { type: "tool_call", id: callId, name: toolName, input } });
                if (state.status === "completed" || state.status === "error") {
                    const metadata =
                        state.metadata !== null && typeof state.metadata === "object"
                            ? (state.metadata as Record<string, unknown>)
                            : {};
                    const title =
                        (typeof state.title === "string" && state.title.trim()) ||
                        (typeof metadata.title === "string" && metadata.title.trim()) ||
                        "";
                    if (title) recoveryToolTitles[callId] = title;
                    const output =
                        typeof state.output === "string"
                            ? state.output
                            : typeof state.error === "string"
                              ? state.error
                              : "";
                    content.push({
                        kind: {
                            type: "tool_result",
                            id: callId,
                            tool_name: toolName,
                            output: {
                                kind: {
                                    type: state.status === "error" ? "error_text" : "text",
                                    text: output,
                                },
                            },
                        },
                    });
                }
            } else if (
                !["compaction", "step-finish", "snapshot", "patch", "agent", "retry"].includes(type)
            ) {
                content.push({
                    kind: {
                        type: "opaque",
                        source: "opencode",
                        kind: type,
                        raw: part,
                    },
                });
            }
        }
        return {
            mid: id,
            ordinal,
            ck: {
                role,
                content,
                ...(Object.keys(recoveryToolTitles).length > 0
                    ? {
                          provider_extras: {
                              opencode: { ctx_expand_tool_titles: recoveryToolTitles },
                          },
                      }
                    : {}),
                meta: {
                    harness_id: id,
                    ordinal,
                    synthetic,
                    summary: info.summary === true,
                    errored: info.error !== undefined && info.error !== null,
                    ...(typeof info.finish === "string" ? { finish: info.finish } : {}),
                    ...(createdAtMs === undefined ? {} : { created_at_ms: createdAtMs }),
                    ...(completedAtMs === undefined ? {} : { completed_at_ms: completedAtMs }),
                },
            },
        };
    });
}

/**
 * Copy the module's JSON trees without structuredClone's serialization pass.
 * Strings are immutable and can be shared; every mutable container must remain
 * private because host postprocessing must not mutate the next delta's basis.
 */
export function cloneModuleNativeOutput(messages: unknown[]): unknown[] {
    const copies = new Map<object, unknown>();
    const copy = (value: unknown): unknown => {
        if (value === null || typeof value !== "object") {
            return typeof value === "function" || typeof value === "symbol"
                ? structuredClone(value)
                : value;
        }
        const prior = copies.get(value);
        if (prior !== undefined) return prior;
        if (Array.isArray(value)) {
            const result: unknown[] = new Array(value.length);
            copies.set(value, result);
            for (let i = 0; i < value.length; i++) if (i in value) result[i] = copy(value[i]);
            return result;
        }
        const prototype = Object.getPrototypeOf(value);
        if (prototype !== Object.prototype && prototype !== null) return structuredClone(value);
        const result: Record<string, unknown> = {};
        copies.set(value, result);
        for (const key of Object.keys(value)) {
            const child = copy((value as Record<string, unknown>)[key]);
            if (key === "__proto__") {
                Object.defineProperty(result, key, {
                    value: child,
                    writable: true,
                    enumerable: true,
                    configurable: true,
                });
            } else result[key] = child;
        }
        return result;
    };
    return copy(messages) as unknown[];
}
