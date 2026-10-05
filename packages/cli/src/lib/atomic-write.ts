import { randomBytes } from "node:crypto";
import {
    chmodSync,
    lstatSync,
    mkdirSync,
    readlinkSync,
    renameSync,
    rmSync,
    statSync,
    writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";

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
 * Write a file atomically: temp sibling + rename. A symlinked target is
 * written through (the link survives and its target is replaced). The prior
 * mode is preserved when the target already exists, so a 0600 config holding
 * keys stays 0600 across doctor/setup rewrites.
 *
 * The temp name is unique per call, so two concurrent writers never share
 * (and clobber) one temp file, and the temp file is removed if the write or
 * the rename fails.
 *
 * Ensures the parent directory exists first: the temp-sibling write (and rename)
 * both fail with ENOENT if the directory is missing. This matters for the
 * CortexKit config location (~/.config/cortexkit/, <project>/.cortexkit/), which
 * does not pre-exist on a fresh machine — so the very first setup must create it.
 * Doing it here kills the whole missing-parent class for every caller rather than
 * relying on each call site to remember an ensureDir.
 */
export function writeFileAtomic(targetPath: string, data: string): void {
    const finalPath = resolveWriteTarget(targetPath);
    mkdirSync(dirname(finalPath), { recursive: true });
    const existing = statSync(finalPath, { throwIfNoEntry: false });
    const mode = existing?.isFile() ? existing.mode & 0o777 : undefined;
    const tmpPath = `${finalPath}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
    try {
        // Create the temp file with the target's mode so its contents are never
        // readable more widely than the file it replaces; chmod afterwards
        // because the umask may have cleared bits the original had.
        writeFileSync(tmpPath, data, {
            encoding: "utf-8",
            flag: "wx",
            ...(mode !== undefined ? { mode } : {}),
        });
        if (mode !== undefined) chmodSync(tmpPath, mode);
        renameSync(tmpPath, finalPath);
    } catch (error) {
        rmSync(tmpPath, { force: true });
        throw error;
    }
}
