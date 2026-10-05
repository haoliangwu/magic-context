/// <reference types="bun-types" />

import { describe, expect, it } from "bun:test";
import { contentTagOwnerMessageId } from "./tag-owner-id";

const DIGEST_A = "a".repeat(64);
const DIGEST_B = "0123456789abcdef".repeat(4);

describe("contentTagOwnerMessageId", () => {
    it("strips positional text and file suffixes", () => {
        expect(contentTagOwnerMessageId("pi-msg-1:p0")).toBe("pi-msg-1");
        expect(contentTagOwnerMessageId("pi-msg-1:p12")).toBe("pi-msg-1");
        expect(contentTagOwnerMessageId("pi-msg-1:file3")).toBe("pi-msg-1");
    });

    it("strips a content-derived text suffix", () => {
        expect(contentTagOwnerMessageId(`pi-msg-1:mc-text-v1:${DIGEST_A}:${DIGEST_B}:o0`)).toBe(
            "pi-msg-1",
        );
        expect(
            contentTagOwnerMessageId(`m:with:colons:mc-text-v1:${DIGEST_A}:${DIGEST_B}:o7`),
        ).toBe("m:with:colons");
    });

    it("leaves an id with no content suffix unchanged", () => {
        expect(contentTagOwnerMessageId("pi-msg-1")).toBe("pi-msg-1");
        expect(contentTagOwnerMessageId("pi-msg-1:pfile")).toBe("pi-msg-1:pfile");
        // A marker without the digest shape is not a content-derived id.
        expect(contentTagOwnerMessageId("pi-msg-1:mc-text-v1:not-hex")).toBe(
            "pi-msg-1:mc-text-v1:not-hex",
        );
    });
});
