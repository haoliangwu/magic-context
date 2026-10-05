/// <reference types="bun-types" />

import { afterEach, describe, expect, it } from "bun:test";
import type { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, type readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { MagicContextRpcServer } from "../../shared/rpc-server";
import { __resetRpcIdentityTestHooks, __setRpcIdentityTestHooks } from "../../shared/rpc-utils";
import { Database } from "../../shared/sqlite";
import { closeQuietly } from "../../shared/sqlite-helpers";
import { createTestTempDirFromPath } from "../../shared/test-temp-dir";
import {
    FAIL_CLOSED_DOCTOR_COMMAND,
    formatFailClosedBlockingMessage,
    formatFailClosedBlockingSummary,
} from "./fail-closed-block";
import {
    __resetSchemaFenceStateForTests,
    closeDatabase,
    getPersistedSchemaVersion,
    LATEST_SUPPORTED_VERSION,
    openDatabase,
} from "./storage-db";
import { describeStorageUnavailability } from "./storage-unavailable-reason";

const tempDirs: string[] = [];
const originalXdgDataHome = process.env.XDG_DATA_HOME;
const originalTestDataDir = process.env.MAGIC_CONTEXT_TEST_DATA_DIR;

function useTempDataHome(): string {
    const dataHome = createTestTempDirFromPath(join(tmpdir(), "storage-unavailable-reason-"));
    tempDirs.push(dataHome);
    process.env.XDG_DATA_HOME = dataHome;
    process.env.MAGIC_CONTEXT_TEST_DATA_DIR = dataHome;
    // A fixed Linux identity probe confirms this test process as the server a
    // discovery record names (bun test runs in UTC, so the local-time `ps` output
    // would not match the record's start time). The empty process list means no
    // Pi harness is live, whatever else runs on this machine.
    __setRpcIdentityTestHooks({
        platform: "linux",
        nowMs: () => 2_000_000,
        readFileSync: ((path: string | URL) => {
            if (String(path) === `/proc/${process.pid}/stat`) {
                return `${process.pid} (opencode) S ${Array.from({ length: 18 }, () => "0").join(" ")} 10000`;
            }
            if (String(path) === "/proc/uptime") return "1000.0 0.0";
            throw new Error(`unexpected identity read: ${String(path)}`);
        }) as typeof readFileSync,
        processListExecFileSync: (() => "") as typeof execFileSync,
    });
    return dataHome;
}

/** A current database with its newest upstream migration removed, so opening it must migrate. */
function seedPendingMigration(dataHome: string): string {
    openDatabase();
    closeDatabase();
    const dbPath = join(dataHome, "cortexkit", "magic-context", "context.db");
    const db = new Database(dbPath);
    db.prepare("DELETE FROM schema_migrations WHERE version = ?").run(LATEST_SUPPORTED_VERSION);
    db.exec("DROP TABLE single_store_state");
    closeQuietly(db);
    return dbPath;
}

function readPersistedVersion(dbPath: string): number {
    const db = new Database(dbPath);
    try {
        return getPersistedSchemaVersion(db);
    } finally {
        closeQuietly(db);
    }
}

/** An RPC discovery record for a live OpenCode server that another process started. */
function writeForeignServerRecord(dbPath: string): string {
    const dir = join(dirname(dbPath), "rpc", "other-project");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `port-${process.pid}-foreign.json`);
    writeFileSync(
        file,
        JSON.stringify({
            port: 43123,
            pid: process.pid,
            started_at: 1_200_000,
            kind: "OpenCode server",
            instance_id: "foreign",
        }),
    );
    return file;
}

afterEach(() => {
    closeDatabase();
    __resetSchemaFenceStateForTests();
    __resetRpcIdentityTestHooks();
    if (originalXdgDataHome === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = originalXdgDataHome;
    if (originalTestDataDir === undefined) delete process.env.MAGIC_CONTEXT_TEST_DATA_DIR;
    else process.env.MAGIC_CONTEXT_TEST_DATA_DIR = originalTestDataDir;
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("describeStorageUnavailability", () => {
    it("names the migration guard refusal with the blocking process kind, PID and both versions", () => {
        const dbPath = seedPendingMigration(useTempDataHome());
        writeForeignServerRecord(dbPath);

        expect(openDatabase()).toBeNull();
        const reason = describeStorageUnavailability("unused fallback");

        expect(reason).toMatchObject({
            kind: "migration_guard",
            persistedVersion: LATEST_SUPPORTED_VERSION - 1,
            supportedVersion: LATEST_SUPPORTED_VERSION,
            blockingProcesses: [{ kind: "OpenCode server", pid: process.pid }],
        });
        const message = formatFailClosedBlockingMessage(reason);
        expect(message).toContain(`OpenCode server (PID ${process.pid})`);
        expect(message).toContain(
            `The database is at upstream migration v${LATEST_SUPPORTED_VERSION - 1}; this build needs v${LATEST_SUPPORTED_VERSION}.`,
        );
        expect(message).toContain("stop it or update its Magic Context build");
        expect(message).toContain(FAIL_CLOSED_DOCTOR_COMMAND);
        expect(formatFailClosedBlockingSummary(reason)).toBe(
            `Magic Context cannot migrate the shared database from v${LATEST_SUPPORTED_VERSION - 1} to v${LATEST_SUPPORTED_VERSION} while OpenCode server (PID ${process.pid}) may still run an older Magic Context build. Stop or update that host, then start this one once.`,
        );
    });

    it("names a schema fence rejection with the database and build versions", () => {
        const dataHome = useTempDataHome();
        const dbPath = join(dataHome, "cortexkit", "magic-context", "context.db");
        mkdirSync(dirname(dbPath), { recursive: true });
        const future = new Database(dbPath);
        future.exec("CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY)");
        future
            .prepare("INSERT INTO schema_migrations (version) VALUES (?)")
            .run(LATEST_SUPPORTED_VERSION + 1);
        closeQuietly(future);

        expect(openDatabase()).toBeNull();
        const reason = describeStorageUnavailability("unused fallback");

        expect(reason).toEqual({
            kind: "schema_fence",
            persistedVersion: LATEST_SUPPORTED_VERSION + 1,
            supportedVersion: LATEST_SUPPORTED_VERSION,
        });
        expect(formatFailClosedBlockingMessage(reason)).toContain(
            `upstream migration lane v${LATEST_SUPPORTED_VERSION + 1}, build supports through v${LATEST_SUPPORTED_VERSION}`,
        );
    });

    it("falls back to the caller's cause when no refusal was recorded", () => {
        useTempDataHome();
        expect(describeStorageUnavailability("disk I/O error")).toEqual({
            kind: "storage_failure",
            cause: "disk I/O error",
        });
    });
});

describe("migration guard and this process's own RPC server", () => {
    it("does not count this process's own running RPC server as a blocking host", async () => {
        const dbPath = seedPendingMigration(useTempDataHome());
        const server = new MagicContextRpcServer(dirname(dbPath), "/tmp/own-project");
        await server.start();
        try {
            const opened = openDatabase();

            expect(opened).not.toBeNull();
            expect(readPersistedVersion(dbPath)).toBe(LATEST_SUPPORTED_VERSION);
        } finally {
            server.stop();
        }
    });

    it("still refuses for a record with this PID that another server instance wrote", async () => {
        const dbPath = seedPendingMigration(useTempDataHome());
        const server = new MagicContextRpcServer(dirname(dbPath), "/tmp/own-project");
        await server.start();
        const foreign = writeForeignServerRecord(dbPath);
        try {
            expect(openDatabase()).toBeNull();
            expect(readPersistedVersion(dbPath)).toBe(LATEST_SUPPORTED_VERSION - 1);
            expect(existsSync(foreign)).toBe(true);
        } finally {
            server.stop();
        }
    });
});
