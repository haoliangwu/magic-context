import { connect } from "node:net";
import { writeFileSync } from "node:fs";
import { deflateSync } from "node:zlib";
import { buildPagedModuleTransformPayloads, encodeOpenCodeMessagesToCk } from "../src/hooks/magic-context/module-wire";

// Deterministic noisy PNG, not a live screenshot. The module preserves the carrier without decoding it.
function png(): string {
    const crc = (bytes: Buffer) => {
        let value = 0xffffffff;
        for (const byte of bytes) {
            value ^= byte;
            for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0);
        }
        return (value ^ 0xffffffff) >>> 0;
    };
    const chunk = (type: string, data: Buffer) => {
        const body = Buffer.concat([Buffer.from(type), data]);
        const head = Buffer.alloc(4); head.writeUInt32BE(data.length);
        const tail = Buffer.alloc(4); tail.writeUInt32BE(crc(body));
        return Buffer.concat([head, body, tail]);
    };
    const width = 300, height = 300;
    const pixels = Buffer.alloc(height * (width * 3 + 1));
    let seed = 7;
    for (let y = 0; y < height; y++) for (let x = 1; x <= width * 3; x++) {
        seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
        pixels[y * (width * 3 + 1) + x] = seed & 255;
    }
    const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(width); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 2;
    return `data:image/png;base64,${Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(pixels)), chunk("IEND", Buffer.alloc(0))]).toString("base64")}`;
}
const image = png();
const native = Array.from({ length: 174 }, (_, index) => ({
    info: { id: `m${index + 1}`, role: "user", sessionID: "ses", time: { created: 1_700_000_000_000 + index } },
    parts: [
        { type: "text", text: `message ${index + 1}\n${"ordinary text with a quote \" and newline\n".repeat(130)}` },
        ...(index < 10 ? [{ type: "file", mime: "image/png", url: image }] : []),
    ],
}));
const body = {
    method: "transform", kind: "transform", v: 2, session_id: "ses",
    serializer_profile: "opencode-aisdk", serve_native: true,
    render_config: "cfg0", provider_id: "anthropic", full_array_fingerprint: "scratch-fp",
    messages: encodeOpenCodeMessagesToCk(native), native_messages: native,
    usage: { current_total_input_tokens: 1000, context_limit_tokens: 100000 },
};
const pagingStart = performance.now();
const pages = buildPagedModuleTransformPayloads(body, undefined, true);
const pagingMs = performance.now() - pagingStart;
if (pages.length !== 1) throw new Error("expected one page");
const page = pages[0]!.page;
const serializeStart = performance.now();
const serialized = Buffer.from(JSON.stringify(page));
const serializationMs = performance.now() - serializeStart;
const composition: Record<string, number> = {};
let escaping = 0;
function visit(value: unknown, path: string[]) {
    if (typeof value === "string") {
        const size = Buffer.byteLength(value);
        escaping += Buffer.byteLength(JSON.stringify(value)) - 2 - size;
        const form = path[0] === "messages" ? "ck" : path[0] === "native_messages" ? "native" : "envelope";
        const category = value.startsWith("data:image/") ? "image_urls" : path.at(-1) === "text" ? "text" : "metadata";
        const key = `${form}.${category}`; composition[key] = (composition[key] ?? 0) + size;
    } else if (Array.isArray(value)) value.forEach((v, i) => visit(v, [...path, String(i)]));
    else if (value && typeof value === "object") for (const [k, v] of Object.entries(value)) visit(v, [...path, k]);
}
visit(page, []);
composition.json_escaping = escaping;
composition.json_structure_keys_numbers = serialized.length - Object.values(composition).reduce((a, b) => a + b, 0);
console.log(JSON.stringify({ bytes: serialized.length, imageCarrierBytes: image.length * 10, pagingMs, serializationMs, composition }));
const fixture = process.env.MC_SYNC_PROBE_FIXTURE;
if (fixture) writeFileSync(fixture, serialized);
const path = process.env.MC_SYNC_PROBE_SOCKET;
if (path) {
    const socket = connect(path);
    await new Promise<void>((resolve, reject) => { socket.once("connect", resolve); socket.once("error", reject); });
    let buffer = Buffer.alloc(0);
    let wake: (() => void) | undefined;
    socket.on("data", (data) => { buffer = Buffer.concat([buffer, data]); wake?.(); });
    const read = async (length: number) => {
        while (buffer.length < length) await new Promise<void>((resolve) => { wake = resolve; });
        const result = buffer.subarray(0, length); buffer = buffer.subarray(length); return result;
    };
    for (let pass = 0; pass < 3; pass++) {
        // Distinct page IDs exercise each pass instead of the completed-page replay cache.
        const request = Buffer.from(JSON.stringify({ ...page, transform_page_id: `scratch-${pass}` }));
        const header = Buffer.alloc(4); header.writeUInt32BE(request.length);
        const start = performance.now();
        await new Promise<void>((resolve, reject) => socket.write(Buffer.concat([header, request]), (error) => error ? reject(error) : resolve()));
        const writeMs = performance.now() - start;
        const responseLength = (await read(4)).readUInt32BE();
        const headerMs = performance.now() - start;
        const response = await read(responseLength);
        const completeMs = performance.now() - start;
        const parseStart = performance.now();
        const decoded = JSON.parse(response.toString());
        console.log(JSON.stringify({ pass, writeMs, headerMs, replyBodyMs: completeMs - headerMs, roundTripMs: completeMs, responseBytes: responseLength, responseParseMs: performance.now() - parseStart, action: decoded.action }));
    }
    socket.destroy();
}
