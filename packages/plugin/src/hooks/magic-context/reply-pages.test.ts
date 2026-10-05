import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { assembleReplyPages } from "./reply-pages";

function pagesFor(text: string) {
    const id = createHash("sha256").update(text).digest("hex");
    const chunks = text.match(/[\s\S]{1,65536}/gu)!;
    return chunks.map((data, index) => ({
        reply_page: {
            id,
            index,
            total: chunks.length,
            bytes: Buffer.byteLength(text),
            data,
        },
    }));
}

describe("module reply paging", () => {
    it("reconstructs a screenshot reply above 4 MiB without changing JSON bytes", async () => {
        const text = JSON.stringify({
            messages: [{ parts: [{ type: "image", data: "abcd".repeat(1_500_000) }] }],
            unicode: "é🦀",
        });
        const pages = pagesFor(text);
        const fetched: number[] = [];
        const response = await assembleReplyPages(pages[0], async (_id, index) => {
            fetched.push(index);
            return pages[index];
        });
        expect(Buffer.byteLength(text)).toBeGreaterThan(4 * 1024 * 1024);
        expect(JSON.stringify(response)).toBe(text);
        expect(fetched).toEqual(Array.from({ length: pages.length - 1 }, (_, i) => i + 1));
    });
    it("never serves a missing, reordered, corrupt or mismatched page", async () => {
        const pages = pagesFor(JSON.stringify({ text: "x".repeat(150_000) }));
        for (const replacement of [
            undefined,
            pages[0],
            { reply_page: { ...pages[1]!.reply_page, data: "corrupt" } },
            { reply_page: { ...pages[1]!.reply_page, id: "a".repeat(64) } },
        ]) {
            await expect(assembleReplyPages(pages[0], async () => replacement)).rejects.toThrow(
                "Incomplete or invalid",
            );
        }
    });
    it("propagates a late page timeout instead of returning partial messages", async () => {
        const pages = pagesFor(JSON.stringify({ text: "x".repeat(150_000) }));
        await expect(
            assembleReplyPages(pages[0], async () => {
                throw new Error("page timed out");
            }),
        ).rejects.toThrow("page timed out");
    });
    it("verifies the digest even when a same-length corruption preserves page metadata", async () => {
        const pages = pagesFor(JSON.stringify({ text: "x".repeat(150_000) }));
        const corrupt = structuredClone(pages);
        corrupt[1]!.reply_page.data = "y" + corrupt[1]!.reply_page.data.slice(1);
        await expect(
            assembleReplyPages(corrupt[0], async (_id, index) => corrupt[index]),
        ).rejects.toThrow("Incomplete or invalid");
    });
});
