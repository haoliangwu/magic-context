import { createHash } from "node:crypto";
import { promises as fs, readFileSync } from "node:fs";
import path from "node:path";
import { getMagicContextStorageDir } from "../../../shared/data-path";
import { projectDirectoryKey } from "../../../shared/project-directory-key";
import { writeStorageFileAtomicSync } from "../../../shared/storage-permissions";

// Lives in shared/ so the TUI (which ships without features/) can use the same
// normalization; re-exported here for the existing importers.
export { projectDirectoryKey };

function cachePath(directory: string, storageDir = getMagicContextStorageDir()): string {
    const hash = createHash("sha256").update(projectDirectoryKey(directory)).digest("hex");
    return path.join(storageDir, "project-identities", `${hash}.json`);
}

/** A small atomic sidecar avoids opening or migrating the store during plugin boot. */
export function rememberGitIdentity(directory: string, identity: string): void {
    try {
        const destination = cachePath(directory);
        writeStorageFileAtomicSync(
            destination,
            JSON.stringify({ directory: projectDirectoryKey(directory), identity }),
        );
    } catch {
        // Read-only storage must not turn a successful git probe into a failure.
    }
}

/** `storageDir` lets offline tools read the sidecars that sit next to a chosen `context.db`. */
export function readRememberedGitIdentity(
    directory: string,
    storageDir?: string,
): string | undefined {
    try {
        const record = JSON.parse(readFileSync(cachePath(directory, storageDir), "utf8"));
        if (
            record.directory === projectDirectoryKey(directory) &&
            /^git:[0-9a-f]{7,64}$/.test(record.identity)
        )
            return record.identity;
    } catch {
        // Missing or damaged cache entries defer resolution rather than inventing an identity.
    }
    return undefined;
}

/** Maintenance only: an inaccessible directory may still exist; prune only confirmed ENOENT records. */
export async function pruneMissingProjectIdentities(
    storageDir = getMagicContextStorageDir(),
): Promise<number> {
    const directory = path.join(storageDir, "project-identities");
    let removed = 0;
    let entries: string[];
    try {
        entries = await fs.readdir(directory);
    } catch {
        return 0;
    }
    for (const entry of entries) {
        if (!/^[0-9a-f]{64}\.json$/.test(entry)) continue;
        const file = path.join(directory, entry);
        try {
            const record = JSON.parse(await fs.readFile(file, "utf8"));
            if (
                typeof record.directory !== "string" ||
                !path.isAbsolute(record.directory) ||
                cachePath(record.directory, storageDir) !== file ||
                !/^git:[0-9a-f]{7,64}$/.test(record.identity)
            )
                continue;
            try {
                await fs.stat(record.directory);
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== "ENOENT") continue;
                await fs.unlink(file);
                removed++;
            }
        } catch {
            // Damaged records and storage failures are not proof a project is gone.
        }
    }
    return removed;
}
