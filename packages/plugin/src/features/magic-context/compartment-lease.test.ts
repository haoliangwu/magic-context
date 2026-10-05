/// <reference types="bun-types" />

import { describe, expect, it } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "../../shared/sqlite";
import { closeQuietly } from "../../shared/sqlite-helpers";
import { createTestTempDirFromPath } from "../../shared/test-temp-dir";
import {
    acquireCompartmentLease,
    getCompartmentLeaseBlocker,
    isCompartmentLeaseHeld,
    releaseCompartmentLease,
    renewCompartmentLease,
} from "./compartment-lease";
import { initializeDatabase } from "./storage-db";

function makeDb(path = ":memory:"): Database {
    const db = new Database(path);
    initializeDatabase(db);
    return db;
}

describe("compartment state lease", () => {
    it("acquires, reports held, and releases", () => {
        const db = makeDb();
        expect(acquireCompartmentLease(db, "ses", "holder-a")).not.toBeNull();
        expect(isCompartmentLeaseHeld(db, "ses", "holder-a")).toBe(true);
        releaseCompartmentLease(db, "ses", "holder-a");
        expect(isCompartmentLeaseHeld(db, "ses", "holder-a")).toBe(false);
        closeQuietly(db);
    });

    it("blocks a second holder while the current lease is not expired", () => {
        const db = makeDb();
        expect(acquireCompartmentLease(db, "ses", "holder-a")).not.toBeNull();
        expect(acquireCompartmentLease(db, "ses", "holder-b")).toBeNull();
        expect(isCompartmentLeaseHeld(db, "ses", "holder-a")).toBe(true);
        closeQuietly(db);
    });

    it("lets the same holder reacquire and extend expiry", () => {
        const db = makeDb();
        const first = acquireCompartmentLease(db, "ses", "holder-a");
        expect(first).not.toBeNull();

        db.prepare("UPDATE compartment_state_lease SET expires_at = ? WHERE session_id = ?").run(
            Date.now() + 1_000,
            "ses",
        );

        const second = acquireCompartmentLease(db, "ses", "holder-a");
        expect(second).not.toBeNull();
        expect(second!.expiresAt).toBeGreaterThan(first!.acquiredAt + 1_000);
        closeQuietly(db);
    });

    it("lets another process reclaim an unexpired lease whose owner pid is dead", () => {
        const db = makeDb();
        db.prepare(
            `INSERT INTO compartment_state_lease
                (session_id, holder_id, owner_pid, acquired_at, expires_at)
             VALUES (?, ?, ?, ?, ?)`,
        ).run("ses", "dead-holder", 2_147_483_647, Date.now(), Date.now() + 60_000);

        expect(acquireCompartmentLease(db, "ses", "holder-b")).not.toBeNull();
        expect(isCompartmentLeaseHeld(db, "ses", "holder-b")).toBe(true);
        closeQuietly(db);
    });

    it("reports the live owner that blocks acquisition", () => {
        const db = makeDb();
        expect(acquireCompartmentLease(db, "ses", "holder-a")).not.toBeNull();
        expect(acquireCompartmentLease(db, "ses", "holder-b")).toBeNull();

        const blocker = getCompartmentLeaseBlocker(db, "ses");
        expect(blocker?.holderId).toBe("holder-a");
        expect(blocker?.ownerPid).toBe(process.pid);
        expect(blocker?.expiresAt).toBeGreaterThan(Date.now());
        closeQuietly(db);
    });

    it("lets another holder reclaim an expired lease", () => {
        const db = makeDb();
        expect(acquireCompartmentLease(db, "ses", "holder-a")).not.toBeNull();

        db.prepare("UPDATE compartment_state_lease SET expires_at = ? WHERE session_id = ?").run(
            Date.now() - 1,
            "ses",
        );

        expect(acquireCompartmentLease(db, "ses", "holder-b")).not.toBeNull();
        expect(isCompartmentLeaseHeld(db, "ses", "holder-b")).toBe(true);
        expect(isCompartmentLeaseHeld(db, "ses", "holder-a")).toBe(false);
        closeQuietly(db);
    });

    it("renew fails for holder mismatch or expired lease", () => {
        const db = makeDb();
        expect(acquireCompartmentLease(db, "ses", "holder-a")).not.toBeNull();
        expect(renewCompartmentLease(db, "ses", "holder-b")).toBe(false);

        db.prepare("UPDATE compartment_state_lease SET expires_at = ? WHERE session_id = ?").run(
            Date.now() - 1,
            "ses",
        );
        expect(renewCompartmentLease(db, "ses", "holder-a")).toBe(false);
        closeQuietly(db);
    });

    it("release is a no-op after another holder reclaims the row", () => {
        const db = makeDb();
        expect(acquireCompartmentLease(db, "ses", "holder-a")).not.toBeNull();

        db.prepare("UPDATE compartment_state_lease SET expires_at = ? WHERE session_id = ?").run(
            Date.now() - 1,
            "ses",
        );

        expect(acquireCompartmentLease(db, "ses", "holder-b")).not.toBeNull();
        releaseCompartmentLease(db, "ses", "holder-a");
        expect(isCompartmentLeaseHeld(db, "ses", "holder-b")).toBe(true);
        closeQuietly(db);
    });

    it("allows exactly one winner across separate DB handles", () => {
        const dir = createTestTempDirFromPath(join(tmpdir(), "mc-lease-handles-"));
        const path = join(dir, "context.db");
        const dbA = makeDb(path);
        const dbB = makeDb(path);
        try {
            const results = [
                acquireCompartmentLease(dbA, "ses", "holder-a"),
                acquireCompartmentLease(dbB, "ses", "holder-b"),
            ];
            expect(results.filter(Boolean)).toHaveLength(1);
        } finally {
            closeQuietly(dbA);
            closeQuietly(dbB);
            try {
                rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
            } catch {
                // Ignore EBUSY on Windows
            }
        }
    });

    it("allows exactly one winner across subprocesses sharing a DB", async () => {
        const dir = createTestTempDirFromPath(join(tmpdir(), "mc-lease-process-"));
        const path = join(dir, "context.db");
        const setup = makeDb(path);
        closeQuietly(setup);

        try {
            const projectRoot = process.cwd().includes("packages")
                ? join(process.cwd(), "..", "..")
                : process.cwd();
            const pluginRoot = join(projectRoot, "packages", "plugin");

            const script = `
                const sqlite = await import(${JSON.stringify(`file://${pluginRoot}/src/shared/sqlite.ts`)});
                const storageDb = await import(${JSON.stringify(`file://${pluginRoot}/src/features/magic-context/storage-db.ts`)});
                const lease = await import(${JSON.stringify(`file://${pluginRoot}/src/features/magic-context/compartment-lease.ts`)});
                let db;
                try {
                    db = new sqlite.Database(${JSON.stringify(path)});
                    storageDb.initializeDatabase(db);
                    const won = lease.acquireCompartmentLease(db, "ses", process.argv.at(-1) ?? "missing-holder") !== null;
                    console.log(JSON.stringify({ outcome: won ? "won" : "lost" }));
                    // Keep the winning PID alive until both contenders have reported their outcomes.
                    if (won) await Bun.stdin.stream().getReader().read();
                } catch (error) {
                    console.log(JSON.stringify({ outcome: "error", error: String(error) }));
                } finally {
                    db?.close();
                }
            `;

            const children = ["holder-a", "holder-b"].map((holder) =>
                Bun.spawn([process.execPath, "-e", script, holder], {
                    stdin: "pipe",
                    stdout: "pipe",
                    stderr: "pipe",
                    windowsHide: true,
                }),
            );
            type Outcome = { outcome: "won" | "lost" | "error"; error?: string };
            const reports = await Promise.all(
                children.map(async (child) => {
                    const reader = child.stdout.getReader();
                    const { value } = await reader.read();
                    if (!value) {
                        const stderr = await new Response(child.stderr).text();
                        return {
                            outcome: "error",
                            error: `exit ${await child.exited}: ${stderr}`,
                        } as Outcome;
                    }
                    try {
                        return JSON.parse(new TextDecoder().decode(value)) as Outcome;
                    } catch (error) {
                        return {
                            outcome: "error",
                            error: `invalid child output: ${String(error)}`,
                        } as Outcome;
                    } finally {
                        reader.releaseLock();
                    }
                }),
            );
            for (const child of children) child.stdin.end();
            const exits = await Promise.all(
                children.map(async (child) => ({
                    code: await child.exited,
                    stderr: await new Response(child.stderr).text(),
                })),
            );
            expect({ reports, exits }).toEqual({
                reports: expect.arrayContaining([{ outcome: "won" }, { outcome: "lost" }]),
                exits: [
                    { code: 0, stderr: "" },
                    { code: 0, stderr: "" },
                ],
            });
            expect(reports).toHaveLength(2);
        } finally {
            try {
                rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
            } catch {
                // Ignore EBUSY on Windows
            }
        }
    });
});
