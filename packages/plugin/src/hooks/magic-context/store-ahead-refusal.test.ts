import { describe, expect, it } from "bun:test";

import {
    renderStoreAheadOfBinaryRefusal,
    StoreAheadOfBinaryError,
    storeAheadOfBinaryFailure,
} from "./store-ahead-refusal";

const WITH_VERSIONS =
    "Magic Context refused to start: its store (store.db) is at schema v63 but this ck-mc build only knows up to v62. Update ck-mc, or roll back by restoring ck-mc together with context.db and store.db from the same backup. (MC-C13)";

describe("store-ahead refusal", () => {
    it("renders the exact sentence the module's facade sends, with and without versions", () => {
        expect(renderStoreAheadOfBinaryRefusal({ dbVersion: 63, binaryMax: 62 })).toBe(
            WITH_VERSIONS,
        );
        expect(renderStoreAheadOfBinaryRefusal(null)).toBe(
            "Magic Context refused to start: its store (store.db) was migrated by a newer ck-mc build than the one running. Update ck-mc, or roll back by restoring ck-mc together with context.db and store.db from the same backup. (MC-C13)",
        );
    });

    it("reads both versions from the error frame detail", () => {
        const frame = Object.assign(new Error("storage open refused"), {
            code: "store_ahead_of_binary",
            detail: { reason_code: "store_ahead_of_binary", db_version: 63, binary_max: 62 },
        });
        const failure = storeAheadOfBinaryFailure(frame);
        expect(failure).toBeInstanceOf(StoreAheadOfBinaryError);
        expect(failure?.versions).toEqual({ dbVersion: 63, binaryMax: 62 });
        expect(failure?.message).toBe(WITH_VERSIONS);
        expect(failure?.cause).toBe(frame);
    });

    it("falls back to the versions in the module's message when detail is missing", () => {
        const operator = Object.assign(
            new Error(
                "storage open refused and is not retried before restart: reason_code=store_ahead_of_binary db_version=63 binary_max=62 reason=x (terminal)",
            ),
            { code: "store_ahead_of_binary" },
        );
        expect(storeAheadOfBinaryFailure(operator)?.versions).toEqual({
            dbVersion: 63,
            binaryMax: 62,
        });
        const facade = Object.assign(new Error(WITH_VERSIONS), { code: "store_ahead_of_binary" });
        expect(storeAheadOfBinaryFailure(facade)?.versions).toEqual({
            dbVersion: 63,
            binaryMax: 62,
        });
    });

    it("finds the refusal anywhere in the cause chain and ignores every other code", () => {
        const frame = Object.assign(new Error("refused"), { code: "store_ahead_of_binary" });
        const wrapped = new Error("transform failed", {
            cause: new Error("call", { cause: frame }),
        });
        expect(storeAheadOfBinaryFailure(wrapped)?.versions).toBeNull();
        expect(
            storeAheadOfBinaryFailure(Object.assign(new Error("x"), { code: "store_open_failed" })),
        ).toBeNull();
        expect(storeAheadOfBinaryFailure(new Error("plain"))).toBeNull();
        expect(storeAheadOfBinaryFailure(undefined)).toBeNull();
        const already = new StoreAheadOfBinaryError({ dbVersion: 2, binaryMax: 1 });
        expect(storeAheadOfBinaryFailure(new Error("outer", { cause: already }))).toBe(already);
    });
});
