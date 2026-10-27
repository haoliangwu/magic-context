import { expect } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { RustTestHarness } from "./rust-harness";

export const FOLD_CONFIG = {
    execute_threshold_tokens: { default: 20_000 },
    protected_tokens: 4_000,
    cache_ttl: "0",
    compressor: { enabled: false },
};

export function assertHermeticStores(h: RustTestHarness): void {
    const pidFile = JSON.parse(readFileSync(join(h.env.dataDir, "cortexkit", "rust-e2e-pids.json"), "utf8")) as { pids: Array<{ pid: number }> };
    const roots = [h.opencode.pid, ...pidFile.pids.map(row => row.pid)];
    const pids = [...roots];
    const tree = spawnSync("ps", ["-axo", "pid=,ppid="], { encoding: "utf8" });
    expect(tree.status).toBe(0);
    const rows = tree.stdout.trim().split("\n").map(line => line.trim().split(/\s+/).map(Number));
    for (let previous = -1; previous !== pids.length;) {
        previous = pids.length;
        for (const [pid, parent] of rows) if (pids.includes(parent!) && !pids.includes(pid!)) pids.push(pid!);
    }
    const files = spawnSync("timeout", ["20s", "lsof", "-p", pids.join(","), "-Fn"], { encoding: "utf8" });
    const observed = new Set(files.stdout.split("\n").filter(line => /^p\d+$/.test(line)).map(line => Number(line.slice(1))));
    // A short-lived host child can exit between ps and lsof. lsof may return 1
    // even though it inspected all fixture processes that were still running.
    expect(roots.every(pid => observed.has(pid))).toBe(true);
    expect(files.status === 0 || (files.status === 1 && pids.some(pid => !observed.has(pid)))).toBe(true);
    const stores = [...new Set(files.stdout.split("\n").filter(line => /^n.*\.db(?:$|-)/.test(line)).map(line => line.slice(1)))];
    console.log(`lsof pids=${pids.join(",")} fixture=${h.env.dataDir} stores=${JSON.stringify(stores)}`);
    expect(stores.length).toBeGreaterThan(0);
    // Native inference may open its telemetry DB under the fixture HOME, beside
    // data/. All stores must remain inside this same generated throwaway root.
    expect(stores.every(path => path.startsWith(`${dirname(h.env.dataDir)}/`))).toBe(true);
    expect(stores.some(path => path.endsWith("opencode.db"))).toBe(true);
    expect(stores.some(path => path.endsWith("store.db"))).toBe(true);
    console.log(`lsof pids=${pids.join(",")} isolated stores=${JSON.stringify(stores.filter(path => path.endsWith(".db")))}`);
}
