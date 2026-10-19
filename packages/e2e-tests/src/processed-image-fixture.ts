import { randomBytes } from "node:crypto";
import { deflateSync } from "node:zlib";

/** Valid, incompressible image data large enough to exercise inline-image stripping. */
export function processedImagePng(): Buffer {
    const chunk = (type: string, data: Buffer) => {
        const body = Buffer.concat([Buffer.from(type), data]);
        let crc = 0xffffffff;
        for (const byte of body) {
            crc ^= byte;
            for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
        }
        const size = Buffer.alloc(4);
        size.writeUInt32BE(data.length);
        const checksum = Buffer.alloc(4);
        checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
        return Buffer.concat([size, body, checksum]);
    };
    const header = Buffer.alloc(13);
    header.writeUInt32BE(128, 0);
    header.writeUInt32BE(128, 4);
    header[8] = 8;
    header[9] = 2;
    const rows = Array.from({ length: 128 }, () =>
        Buffer.concat([Buffer.from([0]), randomBytes(128 * 3)]),
    );
    return Buffer.concat([
        Buffer.from("89504e470d0a1a0a", "hex"),
        chunk("IHDR", header),
        chunk("IDAT", deflateSync(Buffer.concat(rows))),
        chunk("IEND", Buffer.alloc(0)),
    ]);
}
