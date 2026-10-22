import { type Dirent, promises as fs } from "node:fs";
import { join } from "node:path";
import { inspectProcessesAsync, parseRpcPortFile } from "./rpc-utils";

/** Reap only records proven dead; live, unreadable and uncertain records stay. */
export async function reapDeadRpcDiscovery(storageDir: string): Promise<void> {
    const root = join(storageDir, "rpc");
    let directories: Dirent[];
    try {
        directories = await fs.readdir(root, { withFileTypes: true });
    } catch {
        return;
    }
    const records: { path: string; content: string; pid: number }[] = [];
    const projectDirs: string[] = [];
    for (const entry of directories) {
        if (!entry.isDirectory() || !/^[0-9a-f]{16}$/.test(entry.name)) continue;
        const directory = join(root, entry.name);
        projectDirs.push(directory);
        try {
            for (const name of await fs.readdir(directory)) {
                const match = /^port-(\d+)(?:-[0-9a-f]+)?\.json$/.exec(name);
                if (!match) continue;
                const path = join(directory, name);
                try {
                    const content = await fs.readFile(path, "utf8");
                    const record = parseRpcPortFile(content, Number(match[1]));
                    if (record && record.pid === Number(match[1]))
                        records.push({ path, content, pid: record.pid });
                } catch {
                    // Another host may be publishing or stopping this record.
                }
            }
        } catch {
            // An inaccessible project must not prevent cleanup of other projects.
        }
    }
    // Read records before a fresh process snapshot so a recently started host
    // cannot be mistaken for a PID missing from an older cached snapshot.
    const processes = records.length ? await inspectProcessesAsync(true) : undefined;
    for (const record of records) {
        if (processes?.liveness(record.pid) !== "dead") continue;
        try {
            if ((await fs.readFile(record.path, "utf8")) === record.content)
                await fs.unlink(record.path);
        } catch {
            // Leave the record for a later pass; never recursively remove its directory.
        }
    }
    for (const directory of projectDirs) {
        try {
            await fs.rmdir(directory);
        } catch {
            // Leave non-empty directories untouched; they may still contain records for hosts not proven dead.
        }
    }
}
