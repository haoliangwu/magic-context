import { existsSync, statfsSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";

export type FreeBytesProbe = (path: string) => number;

export interface DiskSpaceCheck {
    requiredBytes: number;
    availableBytes: number;
    sufficient: boolean;
}

export function availableDiskBytes(path: string): number {
    const filesystem = statfsSync(path);
    return filesystem.bavail * filesystem.bsize;
}

export function checkDiskSpace(
    path: string,
    bytes: number,
    freeBytes: FreeBytesProbe,
): DiskSpaceCheck {
    const requiredBytes = Math.ceil(bytes * 1.1);
    const availableBytes = freeBytes(path);
    return {
        requiredBytes,
        availableBytes,
        sufficient: availableBytes >= requiredBytes,
    };
}

export function existingDirectoryAncestor(path: string): string {
    let current = resolve(path);
    for (;;) {
        if (existsSync(current) && statSync(current).isDirectory()) return current;
        const parent = dirname(current);
        if (parent === current) throw new Error(`No existing directory for ${path}`);
        current = parent;
    }
}
