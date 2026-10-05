import { createHash } from "node:crypto";
import { isRecord } from "../../shared/record-type-guard";

const MAX_REPLY_BYTES = 128 * 1024 * 1024;
const MAX_PAGE_BYTES = 512 * 1024;

function fail(): never {
    throw Object.assign(new Error("Incomplete or invalid module reply; abandon this pass"), {
        code: "reply_page_invalid",
    });
}

/** Reconstruct the original JSON bytes only after every ordered page and its digest agree. */
export async function assembleReplyPages(
    response: unknown,
    fetchPage: (id: string, index: number) => Promise<unknown>,
): Promise<unknown> {
    if (!isRecord(response) || !("reply_page" in response)) return response;
    const first = response.reply_page;
    if (!isRecord(first)) fail();
    const { id, total, bytes } = first;
    if (
        typeof id !== "string" ||
        !/^[a-f0-9]{64}$/.test(id) ||
        typeof total !== "number" ||
        !Number.isSafeInteger(total) ||
        total < 2 ||
        total > 4096 ||
        typeof bytes !== "number" ||
        !Number.isSafeInteger(bytes) ||
        bytes <= 0 ||
        bytes > MAX_REPLY_BYTES
    )
        fail();
    const chunks: Buffer[] = [];
    let received = 0;
    for (let index = 0; index < total; index += 1) {
        const envelope: unknown = index === 0 ? response : await fetchPage(id, index);
        if (!isRecord(envelope) || !isRecord(envelope.reply_page)) fail();
        const page: Record<string, unknown> = envelope.reply_page;
        if (
            page.id !== id ||
            page.index !== index ||
            page.total !== total ||
            page.bytes !== bytes ||
            typeof page.data !== "string"
        )
            fail();
        if (Buffer.byteLength(JSON.stringify(envelope)) > MAX_PAGE_BYTES) fail();
        const chunk = Buffer.from(page.data, "utf8");
        received += chunk.length;
        if (received > bytes) fail();
        chunks.push(chunk);
    }
    if (received !== bytes) fail();
    const rebuilt = Buffer.concat(chunks, received);
    if (createHash("sha256").update(rebuilt).digest("hex") !== id) fail();
    return JSON.parse(rebuilt.toString("utf8"));
}
