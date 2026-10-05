import { existsSync, lstatSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";

export interface WriteFence {
    roots: string[];
    before: Map<string, string>;
}

function scan(path: string, snapshot: Map<string, string>, descend: boolean): void {
    if (!existsSync(path)) return;
    const stat = lstatSync(path, { bigint: true });
    // A Finder .DS_Store can change independently of the test host; directory
    // timestamps also change when Finder creates one. Fence descendants instead.
    snapshot.set(path, stat.isDirectory() ? `${stat.ino}:${stat.mode}` : `${stat.ino}:${stat.mtimeNs}:${stat.size}:${stat.mode}`);
    if (stat.isDirectory()) {
        // Vendored dependencies and build outputs can contain hundreds of thousands of files.
        // Their directory metadata is still captured, but their descendants are not walked.
        if (descend && ["node_modules", "target", ".git"].includes(basename(path))) return;
        for (const name of readdirSync(path)) {
            if (name === ".DS_Store") continue;
            const child = join(path, name);
            if (descend) scan(child, snapshot, true);
            else {
                const entry = lstatSync(child, { bigint: true });
                // A child's directory mtime tracks writes deeper inside it, outside the HOME top-level fence.
                snapshot.set(child, entry.isDirectory() ? `${entry.ino}:${entry.mode}` : `${entry.ino}:${entry.mtimeNs}:${entry.size}:${entry.mode}`);
            }
        }
    }
}

/** Inspect metadata only; never open the operator's database or configuration files. */
export function snapshotWriteFence(referencedDirectories: string[], home = homedir()): WriteFence {
    const roots = [...new Set(referencedDirectories.filter(path => path.startsWith("/")).map(path => resolve(path)))];
    const before = new Map<string, string>();
    for (const root of roots) scan(root, before, true);
    scan(home, before, false);
    return { roots, before };
}

export function assertWriteFenceUnchanged(fence: WriteFence, home = homedir()): void {
    const after = new Map<string, string>();
    for (const root of fence.roots) scan(root, after, true);
    scan(home, after, false);
    const changed = [...new Set([...fence.before.keys(), ...after.keys()])].find(path => fence.before.get(path) !== after.get(path));
    if (changed) throw new Error(`E2E_HOST_WRITE_FENCE: created, removed or modified ${changed}`);
}
