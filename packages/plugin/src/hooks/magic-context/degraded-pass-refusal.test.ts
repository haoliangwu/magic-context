import { describe, expect, test } from "bun:test";
import { DegradedPassRefusalError, degradedPassError } from "./degraded-pass-refusal";

describe("persistent transform refusal causes", () => {
    test("OpenCode degraded fallback names nested corruption without busy or retry advice", () => {
        const cause = new Error("Pi served ledger JSON record is corrupt");
        const error = new DegradedPassRefusalError("messages-transform-failed", {
            cause: new DegradedPassRefusalError("tagging-persistence-failure", { cause }),
        });
        expect(error.message).toContain("MC-S06");
        expect(error.message).toContain(
            "messages-transform-failed: tagging-persistence-failure: Pi served ledger JSON record is corrupt",
        );
        expect(error.message).not.toContain("storage is busy");
        expect(error.message.toLowerCase()).not.toContain("send your message again");
    });

    test("SQLite contention remains a transient error instead of a persistent refusal", () => {
        for (const code of ["SQLITE_BUSY", "SQLITE_LOCKED", "SQLITE_BUSY_SNAPSHOT"]) {
            const error = Object.assign(new Error("lock contention"), { code });
            expect(degradedPassError("tagging", error)).toBe(error);
        }
    });

    test("non-Error and cyclic causes can be named safely", () => {
        expect(degradedPassError("tagging", "broken record").message).toContain(
            "tagging: broken record",
        );
        const error = new Error("bad record");
        error.cause = error;
        expect(degradedPassError("tagging", error).message).toContain("tagging: bad record");
    });
});
