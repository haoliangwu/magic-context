import { isRecord } from "../../shared/record-type-guard";

/** Compare m[0]/m[1] text and muralDataUrl image with the two knowledge messages last served. */
export function servedPrefixMatches(args: {
    messages: readonly unknown[] | null | undefined;
    m0Text: string | null | undefined;
    m1Text: string | null | undefined;
    muralDataUrl?: string | null;
}): boolean {
    const heads = args.messages?.slice(0, 2);
    if (!heads || heads.length !== 2 || args.m0Text == null || args.m1Text == null) return false;
    const text = (message: unknown): string | undefined => {
        if (!isRecord(message)) return undefined;
        if (typeof message.content === "string") return message.content;
        const parts = Array.isArray(message.parts) ? message.parts : message.content;
        if (!Array.isArray(parts)) return undefined;
        return parts
            .filter(isRecord)
            .filter((part) => part.type === "text")
            .map((part) => String(part.text ?? ""))
            .join("");
    };
    if (text(heads[0]) !== args.m0Text || text(heads[1]) !== args.m1Text) return false;
    const head = heads[0];
    if (!isRecord(head)) return false;
    const parts = Array.isArray(head.parts) ? head.parts : head.content;
    if (!Array.isArray(parts)) return !args.muralDataUrl;
    const images = parts
        .filter(isRecord)
        .filter((part) => part.type === "image" || part.type === "file");
    if (!args.muralDataUrl) return images.length === 0;
    if (images.length !== 1) return false;
    const image = images[0];
    const url =
        typeof image.url === "string"
            ? image.url
            : typeof image.data === "string" && typeof image.mimeType === "string"
              ? `data:${image.mimeType};base64,${image.data}`
              : undefined;
    return url === args.muralDataUrl;
}
