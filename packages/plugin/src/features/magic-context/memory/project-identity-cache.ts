import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
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
