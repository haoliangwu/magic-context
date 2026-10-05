/// <reference types="bun-types" />

/**
 * Single-store rehearsal, Pi step: run the pinned Pi host (MC_E2E_PI_VERSION, the
 * rehearsal uses 0.87.1) with this checkout's plugin against a clone of a migrated
 * store, mock provider only.
 *
 *   TMPDIR=<host-root>/tmp MC_E2E_PI_VERSION=0.87.1 \
 *     bun scripts/b2-drill/pi-drill.ts <host-root>
 *
 * <host-root>/data/cortexkit/magic-context/{context,store}.db must be a throwaway copy
 * under $TMPDIR/magic-context/. Pi's own agent directory is created under TMPDIR, so
 * point TMPDIR inside the host root too. Two turns must complete with Magic Context
 * active, the shared compartments must stay readable, and every database Pi holds
 * open must lie inside the root.
 */

import { Database } from "bun:sqlite";
import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { join } from "node:path";

import { PiTestHarness } from "../../packages/e2e-tests/src/pi-harness";
import { resolvePiPackageJson } from "../../packages/e2e-tests/src/pi-runner/spawn";

const rootArg = process.argv[2];
if (!rootArg) {
    console.error("usage: pi-drill.ts <host-root>");
    process.exit(2);
}
const root = realpathSync(rootArg);
if (!root.includes("/magic-context/") || !realpathSync(process.env.TMPDIR ?? "/").startsWith(root)) {
    console.error("the host root must be under $TMPDIR/magic-context/ and TMPDIR must point inside it");
    process.exit(2);
}
const dataDir = join(root, "data");
const contextPath = join(dataDir, "cortexkit", "magic-context", "context.db");
const log = (event: string, detail: Record<string, unknown> = {}) =>
    console.log(JSON.stringify({ at: new Date().toISOString(), event, ...detail }));

const counts = () => {
    // Read-write open: a WAL-mode copy without its -shm file cannot be opened read-only.
    const db = new Database(contextPath);
    try {
        return db
            .query("SELECT COUNT(*) AS compartments, COUNT(DISTINCT session_id) AS sessions FROM compartments")
            .get();
    } finally {
        db.close();
    }
};

log("pi-package", { packageJson: resolvePiPackageJson("pi") });
// The harness refuses to finish if any recorded subagent call used a real model, and a
// copied real store carries months of such audit rows from real sessions. Remove only
// those historical audit rows from this copy, so the guard judges this run's calls.
{
    const db = new Database(contextPath);
    try {
        const removed = db.run("DELETE FROM subagent_invocations").changes;
        log("historical-audit-rows-removed", { removed });
    } finally {
        db.close();
    }
}
const before = counts();
const h = await PiTestHarness.create({
    sharedDataDir: dataDir,
    magicContextConfig: { embedding: { provider: "off" }, dreamer: { disable: true } },
});
let failed: unknown;
try {
    const first = await h.sendPrompt("pi drill turn one on the migrated shared store");
    const second = await h.sendPrompt("pi drill turn two", { continueSession: true });
    const systemSeen = h.mock
        .requests()
        .some((request) => JSON.stringify(request.body.system ?? "").includes("Magic Context"));
    const out = spawnSync("lsof", ["-p", String(h.hostPid), "-Fn"], { encoding: "utf8" });
    const databases = out.stdout
        .split("\n")
        .filter((line) => line.startsWith("n") && /\.db(?:-wal|-shm)?$/.test(line))
        .map((line) => line.slice(1));
    const outside = databases.filter(
        (path) => !path.startsWith(root) && !`/private${path}`.startsWith(root),
    );
    log("pi-turns", {
        hostPid: h.hostPid,
        first: JSON.stringify(first).slice(0, 200),
        second: JSON.stringify(second).slice(0, 200),
        magicContextInSystem: systemSeen,
        databases,
        before,
        after: counts(),
    });
    if (!systemSeen) throw new Error("Magic Context was not active in the Pi requests");
    if (out.status !== 0 || outside.length > 0) throw new Error(`Pi opened databases outside the root: ${outside}`);
    log("done", { ok: true });
} catch (error) {
    failed = error;
    log("failed", { error: String(error) });
} finally {
    await h.dispose();
}
if (failed) process.exit(1);
