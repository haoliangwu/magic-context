import { chmodSync, lstatSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Reuse Bun's native-addon extraction while keeping host data in per-run roots. */
export function hostExtractCache(): string {
    const parent = join(tmpdir(), "magic-context");
    const path = join(parent, "host-extract-cache");
    for (const directory of [parent, path]) {
        mkdirSync(directory, { recursive: true, mode: 0o700 });
        const stats = lstatSync(directory);
        if (!stats.isDirectory() || stats.uid !== process.getuid?.()) {
            throw new Error(`Host extraction cache is not a directory: ${directory}`);
        }
        chmodSync(directory, 0o700);
    }
    return path;
}
