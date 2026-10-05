import { expect, test } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { closeDatabase, openDatabase, resolveDatabasePath } from "../../src/features/magic-context/storage-db";

const probeDir = process.env.MC_PARALLEL_DB_PROBE_DIR;
if (!probeDir) throw new Error("MC_PARALLEL_DB_PROBE_DIR is required for the parallel DB probe");

const sharedDataHome = process.env.MC_PARALLEL_DB_PROBE_SHARED_DATA_HOME;
if (sharedDataHome) {
    process.env.MAGIC_CONTEXT_TEST_DATA_DIR = sharedDataHome;
    process.env.XDG_DATA_HOME = sharedDataHome;
}

async function waitForWriter(): Promise<void> {
    const ready = join(probeDir, "worker-a.json");
    const deadline = Date.now() + 10_000;
    while (!existsSync(ready)) {
        if (Date.now() >= deadline) throw new Error("worker A never acquired the database lock");
        await Bun.sleep(20);
    }
}

test("worker B can open its own default database while worker A is locked", async () => {
    await waitForWriter();
    writeFileSync(join(probeDir, "worker-b-ready"), "");

    const opened = openDatabase();
    expect(opened).not.toBeNull();
    closeDatabase();

    const { dbPath } = resolveDatabasePath();
    writeFileSync(
        join(probeDir, "worker-b.json"),
        JSON.stringify({
            pid: process.pid,
            dataHome: process.env.MAGIC_CONTEXT_TEST_DATA_DIR,
            dbPath,
        }),
    );
});
