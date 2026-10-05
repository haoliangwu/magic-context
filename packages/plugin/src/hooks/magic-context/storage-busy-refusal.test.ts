import { describe, expect, test } from "bun:test";
import { SqliteAcquisitionBusyError } from "../../shared/sqlite";
import { describeStorageBusyCause } from "./storage-busy-refusal";

describe("storage-busy refusal cause", () => {
    test("names the SQLite error under nested acquisition wrappers", () => {
        const sqlite = Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" });
        const wrapped = new SqliteAcquisitionBusyError(new SqliteAcquisitionBusyError(sqlite));
        const detail = describeStorageBusyCause(wrapped);
        expect(detail.startsWith("database is locked")).toBe(true);
        expect(detail).not.toContain("SQLite writer acquisition remained busy");
    });

    test("describes a non-error cause as text", () => {
        expect(describeStorageBusyCause("busy")).toBe("busy");
    });
});
