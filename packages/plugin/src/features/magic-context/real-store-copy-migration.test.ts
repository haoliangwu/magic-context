/// <reference types="bun-types" />

/**
 * Apply this build's context.db migrations to a copy of a real store, and prove an
 * older build refuses the result instead of writing to it.
 *
 * Inert unless `MC_REAL_CONTEXT_COPY` names a `context.db` copy made with
 * `sqlite3 -readonly <live context.db> "VACUUM INTO '<throwaway path>'"`. The test
 * copies that file again beside itself and only ever opens the second copy.
 *
 * With `MC_FENCE_OLD_PLUGIN_SRC` pointing at an older checkout's `packages/plugin/src`
 * (for example `git archive` of the previous release), the migrated copy is also
 * handed to that build's `openDatabase`. It must refuse (return null and record
 * a schema-fence rejection) and must leave the main database file byte-identical.
 */

import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { closeSync, copyFileSync, existsSync, openSync, readSync, rmSync } from "node:fs";

import { Database } from "../../shared/sqlite";
import { LATEST_MIGRATION_VERSION } from "./migrations";
import { closeDatabase, getPersistedSchemaVersion, openDatabase } from "./storage-db";

const source = process.env.MC_REAL_CONTEXT_COPY;
const oldPluginSrc = process.env.MC_FENCE_OLD_PLUGIN_SRC;

/** Streamed: a real store is several gigabytes and does not fit in one buffer. */
function sha256(path: string): string {
    const hash = createHash("sha256");
    const fd = openSync(path, "r");
    const chunk = Buffer.allocUnsafe(8 * 1024 * 1024);
    try {
        for (;;) {
            const read = readSync(fd, chunk, 0, chunk.length, null);
            if (read === 0) break;
            hash.update(chunk.subarray(0, read));
        }
    } finally {
        closeSync(fd);
    }
    return hash.digest("hex");
}

describe.skipIf(!source)("a copy of a real context.db", () => {
    const working = `${source}.migrate-${process.pid}.db`;

    test("migrates to this build's fence, passes quick_check, and an older build refuses it", async () => {
        copyFileSync(source!, working);
        const probe = new Database(working, { readonly: true });
        const before = getPersistedSchemaVersion(probe);
        probe.close();

        const started = performance.now();
        const db = openDatabase(working);
        const elapsedMs = Math.round(performance.now() - started);
        expect(db).not.toBeNull();
        const after = getPersistedSchemaVersion(db!);
        const quickCheck = (db!.prepare("PRAGMA quick_check").get() as { quick_check: string })
            .quick_check;
        const watermarks = (
            db!.prepare("SELECT COUNT(*) AS n FROM memory_embedding_watermarks").get() as {
                n: number;
            }
        ).n;
        closeDatabase();
        console.log(
            `real context copy: before=v${before} after=v${after} elapsed_ms=${elapsedMs} quick_check=${quickCheck} watermark_rows=${watermarks}`,
        );
        expect(after).toBe(LATEST_MIGRATION_VERSION);
        expect(quickCheck).toBe("ok");

        if (oldPluginSrc) {
            // Checkpoint so the main file carries every page before it is hashed.
            const checkpoint = new Database(working);
            checkpoint.exec("PRAGMA wal_checkpoint(TRUNCATE)");
            checkpoint.close();
            const digestBefore = sha256(working);
            const old = (await import(
                `${oldPluginSrc}/features/magic-context/storage-db.ts`
            )) as typeof import("./storage-db");
            let refused: Database | null | "threw" = null;
            let thrown = "";
            try {
                refused = old.openDatabase(working);
            } catch (error) {
                refused = "threw";
                thrown = String(error);
            }
            const rejection = old.getSchemaFenceRejection();
            console.log(
                `older build on the migrated copy: result=${refused === null ? "null" : refused === "threw" ? `threw ${thrown}` : "OPENED"} rejection=${JSON.stringify(rejection)} older_fence=v${old.LATEST_SUPPORTED_VERSION}`,
            );
            expect(refused).toBeNull();
            expect(rejection).toEqual({
                persistedVersion: LATEST_MIGRATION_VERSION,
                supportedVersion: old.LATEST_SUPPORTED_VERSION,
            });
            expect(sha256(working)).toBe(digestBefore);
        }
        if (!process.env.MC_REAL_STORE_KEEP) {
            for (const suffix of ["", "-wal", "-shm"])
                if (existsSync(`${working}${suffix}`)) rmSync(`${working}${suffix}`);
        }
    }, 1_800_000);
});
