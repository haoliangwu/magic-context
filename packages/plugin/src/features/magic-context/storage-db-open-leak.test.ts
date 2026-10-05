/// <reference types="bun-types" />

import { afterEach, describe, expect, it } from "bun:test";
import { readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestTempDirFromPath } from "../../shared/test-temp-dir";
import { closeDatabase, openDatabase, openDatabaseAsync } from "./storage-db";

const directories: string[] = [];

afterEach(() => {
    closeDatabase();
    for (const directory of directories.splice(0)) {
        rmSync(directory, { recursive: true, force: true });
    }
});

function openFileDescriptorCount(): number {
    return readdirSync("/dev/fd").length;
}

/** A file SQLite opens but cannot read, so the open fails after the connection exists. */
function corruptDatabasePath(): string {
    const directory = createTestTempDirFromPath(join(tmpdir(), "storage-db-open-leak-"));
    directories.push(directory);
    const path = join(directory, "context.db");
    writeFileSync(path, Buffer.alloc(8192, 0x5a));
    return path;
}

describe("failed database opens", () => {
    it("close the connection when the synchronous open throws", () => {
        const path = corruptDatabasePath();
        expect(() => openDatabase(path)).toThrow();
        const before = openFileDescriptorCount();

        for (let attempt = 0; attempt < 5; attempt += 1) {
            expect(() => openDatabase(path)).toThrow();
        }

        expect(openFileDescriptorCount()).toBe(before);
    });

    it("close the connection when the async open throws", async () => {
        const path = corruptDatabasePath();
        await expect(openDatabaseAsync(path)).rejects.toThrow();
        const before = openFileDescriptorCount();

        for (let attempt = 0; attempt < 5; attempt += 1) {
            await expect(openDatabaseAsync(path)).rejects.toThrow();
        }

        expect(openFileDescriptorCount()).toBe(before);
    });
});
