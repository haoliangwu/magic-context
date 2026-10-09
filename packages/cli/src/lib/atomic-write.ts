import { randomBytes } from "node:crypto";
import {
    lstatSync,
    mkdirSync,
    readlinkSync,
    renameSync,
    rmSync,
    statSync,
    writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { writeStorageFileAtomicSync } from "@magic-context/core/shared/storage-permissions";

/** Same bound the OS applies to symlink resolution (ELOOP on Linux is 40). */
const MAX_SYMLINK_HOPS = 40;

/**
 * The regular-file path a write to `targetPath` should land on. Dotfile
 * managers (stow, chezmoi, home-manager) install configs as symlinks into a
 * repository; renaming a temp file over the link would replace the link with
 * a regular file and silently detach the config from that repository. The
 * chain is followed by hand rather than with realpath so a link whose target
 * does not exist yet still resolves (the write then creates the target).
 */
function resolveWriteTarget(targetPath: string): string {
    let current = resolve(targetPath);
    for (let hop = 0; hop < MAX_SYMLINK_HOPS; hop++) {
        const stat = lstatSync(current, { throwIfNoEntry: false });
        if (!stat?.isSymbolicLink()) return current;
        current = resolve(dirname(current), readlinkSync(current));
    }
    throw new Error(`Too many levels of symbolic links resolving ${targetPath}`);
}

/**
 * Atomically replace a config. `ownerOnly` is for Magic Context's own user
 * config; unrelated host configs retain their existing mode or the normal
 * process creation mode.
 */
export function writeFileAtomic(
    targetPath: string,
    data: string,
    options: { ownerOnly?: boolean } = {},
): void {
    const finalPath = resolveWriteTarget(targetPath);
    if (options.ownerOnly) {
        writeStorageFileAtomicSync(finalPath, data, true);
        return;
    }

    mkdirSync(dirname(finalPath), { recursive: true });
    const existing = statSync(finalPath, { throwIfNoEntry: false });
    const mode = existing?.isFile() ? existing.mode & 0o777 : undefined;
    const tmpPath = `${finalPath}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
    try {
        writeFileSync(tmpPath, data, {
            encoding: "utf-8",
            flag: "wx",
            ...(mode !== undefined ? { mode } : {}),
        });
        renameSync(tmpPath, finalPath);
    } catch (error) {
        rmSync(tmpPath, { force: true });
        throw error;
    }
}
