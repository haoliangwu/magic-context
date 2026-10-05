import { execFileSync } from "node:child_process";
import { statSync } from "node:fs";
import { assertOpenPaths } from "./opencode2-runner/spawn";

/** Fail closed on an unavailable inventory, and prove that this PID owns the expected store. */
export function inspectHostOpenFiles(pid: number, root: string, requiredDatabase?: string) {
    process.kill(pid, 0);
    // Names and service lookups can block lsof on CI's network. Numeric socket
    // labels still inventory every descriptor; filesystem paths are unchanged.
    const inventory = execFileSync("timeout", ["10s", "lsof", "-nP", "-p", String(pid), "-Fin"], {
        encoding: "utf8",
    });
    const paths: string[] = [];
    let inode: number | undefined;
    const expectedInode = requiredDatabase ? statSync(requiredDatabase).ino : undefined;
    let ownsDatabase = false;
    for (const line of inventory.split("\n")) {
        if (line.startsWith("f")) inode = undefined;
        if (line.startsWith("i")) inode = Number(line.slice(1));
        if (!line.startsWith("n")) continue;
        const path = line.slice(1);
        paths.push(path);
        if (path === requiredDatabase && inode === expectedInode) ownsDatabase = true;
    }
    assertOpenPaths(paths, root);
    if (paths.length === 0) throw new Error(`Empty open-file inventory for host PID ${pid}`);
    if (requiredDatabase && !ownsDatabase) {
        throw new Error(`Host PID ${pid} does not hold the expected database inode: ${requiredDatabase}`);
    }
    const databases = paths.filter((path) => /\.db(-wal|-shm)?$/.test(path));
    return { pid, inventory, databases };
}
