/**
 * Process-wide storage permission policy resolved from trusted user config.
 *
 * Storage is shared by OpenCode and Pi, so all writers consult one setting before
 * applying POSIX modes. The default preserves the historical owner-only policy.
 */
import { randomBytes } from "node:crypto";
import type { WriteStream } from "node:fs";
import {
    chmodSync,
    closeSync,
    createWriteStream,
    lstatSync,
    mkdirSync,
    openSync,
    readdirSync,
    readlinkSync,
    readSync,
    renameSync,
    rmSync,
    symlinkSync,
    writeFileSync,
    writeSync,
} from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { open as openAsync, writeFile as writeFileAsync } from "node:fs/promises";
import { dirname, join } from "node:path";

let enforcePrivateStoragePermissions = true;

export function setStoragePrivatePermissionEnforcement(enforce: boolean): void {
    enforcePrivateStoragePermissions = enforce;
}

export function shouldEnforcePrivateStoragePermissions(): boolean {
    return enforcePrivateStoragePermissions;
}

/** Test-only reset for suites that exercise both permission policies in one process. */
export function __resetStoragePrivatePermissionEnforcementForTests(): void {
    enforcePrivateStoragePermissions = true;
}

/** Create storage directories with owner-only permissions at their creation. */
export function ensureStorageDirectorySync(
    directory: string,
    forcePrivate = false,
    recursive = true,
): void {
    const privateMode = forcePrivate || shouldEnforcePrivateStoragePermissions();
    mkdirSync(directory, {
        recursive,
        ...(privateMode ? { mode: 0o700 } : {}),
    });
}

/** Create or replace a storage file using a private mode from the first byte. */
export function writeStorageFileSync(
    filePath: string,
    content: string | Uint8Array,
    options: { encoding?: BufferEncoding; flag?: string; forcePrivate?: boolean } = {},
): void {
    const { forcePrivate = false, ...writeOptions } = options;
    const privateMode = forcePrivate || shouldEnforcePrivateStoragePermissions();
    writeFileSync(filePath, content, {
        ...writeOptions,
        ...(privateMode ? { mode: 0o600 } : {}),
    });
}

/** Write a private sibling then atomically publish it without a permissive temp window. */
export function writeStorageFileAtomicSync(
    filePath: string,
    content: string | Uint8Array,
    forcePrivate = false,
): void {
    ensureStorageDirectorySync(dirname(filePath), forcePrivate);
    const tempPath = `${filePath}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
    try {
        writeStorageFileSync(tempPath, content, { flag: "wx", forcePrivate });
        renameSync(tempPath, filePath);
    } catch (error) {
        rmSync(tempPath, { force: true });
        throw error;
    }
}

export function copyStorageFileSync(
    sourcePath: string,
    destinationPath: string,
    forcePrivate = false,
): void {
    ensureStorageDirectorySync(dirname(destinationPath), forcePrivate);
    const privateMode = forcePrivate || shouldEnforcePrivateStoragePermissions();
    const sourceFd = openSync(sourcePath, "r");
    let destinationFd: number | undefined;
    try {
        destinationFd = openSync(destinationPath, "wx", privateMode ? 0o600 : 0o666);
        const buffer = Buffer.allocUnsafe(1024 * 1024);
        for (;;) {
            const bytesRead = readSync(sourceFd, buffer, 0, buffer.length, null);
            if (bytesRead === 0) break;
            let offset = 0;
            while (offset < bytesRead) {
                offset += writeSync(destinationFd, buffer, offset, bytesRead - offset);
            }
        }
    } catch (error) {
        if (destinationFd !== undefined) rmSync(destinationPath, { force: true });
        throw error;
    } finally {
        closeSync(sourceFd);
        if (destinationFd !== undefined) closeSync(destinationFd);
    }
}

export function copyStorageTreeSync(
    sourcePath: string,
    destinationPath: string,
    forcePrivate = false,
): void {
    const stat = lstatSync(sourcePath);
    if (stat.isSymbolicLink()) {
        ensureStorageDirectorySync(dirname(destinationPath), forcePrivate);
        symlinkSync(readlinkSync(sourcePath), destinationPath);
        return;
    }
    if (!stat.isDirectory()) {
        copyStorageFileSync(sourcePath, destinationPath, forcePrivate);
        return;
    }
    ensureStorageDirectorySync(destinationPath, forcePrivate);
    for (const entry of readdirSync(sourcePath)) {
        copyStorageTreeSync(join(sourcePath, entry), join(destinationPath, entry), forcePrivate);
    }
}

export function openStorageFileSync(filePath: string, flags: string, forcePrivate = false): number {
    ensureStorageDirectorySync(dirname(filePath), forcePrivate);
    const privateMode = forcePrivate || shouldEnforcePrivateStoragePermissions();
    return openSync(filePath, flags, privateMode ? 0o600 : 0o666);
}

export async function writeStorageFileAsync(
    filePath: string,
    content: string | Uint8Array,
    forcePrivate = false,
): Promise<void> {
    const privateMode = forcePrivate || shouldEnforcePrivateStoragePermissions();
    ensureStorageDirectorySync(dirname(filePath), privateMode);
    await writeFileAsync(filePath, content, privateMode ? { mode: 0o600 } : undefined);
}

export async function writeStorageFileHandleAsync(
    handle: FileHandle,
    content: string,
): Promise<void> {
    await handle.writeFile(content);
}

export function createStorageWriteStream(filePath: string, forcePrivate = false): WriteStream {
    const privateMode = forcePrivate || shouldEnforcePrivateStoragePermissions();
    return createWriteStream(filePath, privateMode ? { mode: 0o600 } : undefined);
}

export async function createStorageFileHandleAsync(
    filePath: string,
    flags: string,
    forcePrivate = false,
) {
    const privateMode = forcePrivate || shouldEnforcePrivateStoragePermissions();
    return openAsync(filePath, flags, privateMode ? 0o600 : undefined);
}

/** Tighten existing entries during storage startup; symlinks are never followed. */
export function tightenStorageTreeSync(root: string): { tightened: number; failures: number } {
    if (!shouldEnforcePrivateStoragePermissions() || process.platform === "win32") {
        return { tightened: 0, failures: 0 };
    }
    let tightened = 0;
    let failures = 0;
    const visit = (entryPath: string): void => {
        let stat: ReturnType<typeof lstatSync>;
        try {
            stat = lstatSync(entryPath);
        } catch {
            failures++;
            return;
        }
        if (stat.isSymbolicLink()) return;
        const mode = stat.isDirectory() ? 0o700 : 0o600;
        if ((stat.mode & 0o077) !== 0 || (stat.mode & 0o777) !== mode) {
            try {
                chmodSync(entryPath, mode);
                tightened++;
            } catch {
                failures++;
            }
        }
        if (!stat.isDirectory()) return;
        let entries: string[];
        try {
            entries = readdirSync(entryPath);
        } catch {
            failures++;
            return;
        }
        for (const entry of entries) visit(join(entryPath, entry));
    };
    visit(root);
    return { tightened, failures };
}
