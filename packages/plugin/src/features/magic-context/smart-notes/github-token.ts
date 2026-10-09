import { constants as fsConstants } from "node:fs";
import { open } from "node:fs/promises";
import path from "node:path";

import { getMagicContextStorageDir } from "../../../shared/data-path";
import { log } from "../../../shared/logger";

const OWNER_ONLY_MODE = 0o600;
const INSECURE_FILE_WARNING =
    "[magic-context] ignoring GitHub token file because it must have owner-only permissions (0600)";

/** Read the optional host credential once at the start of a smart-note sweep. */
export async function readSmartNoteGithubToken(
    options: { warn?: (message: string) => void } = {},
): Promise<string | null> {
    const filePath = path.join(getMagicContextStorageDir(), "github-token");
    const noFollow = typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0;
    const nonBlock = typeof fsConstants.O_NONBLOCK === "number" ? fsConstants.O_NONBLOCK : 0;
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
        handle = await open(filePath, fsConstants.O_RDONLY | noFollow | nonBlock);
        const stat = await handle.stat();
        if (!stat.isFile() || (stat.mode & 0o777) !== OWNER_ONLY_MODE) {
            (options.warn ?? log)(INSECURE_FILE_WARNING);
            return null;
        }
        return (await handle.readFile({ encoding: "utf8" })).trim() || null;
    } catch {
        // Missing files and inaccessible credentials preserve today's public-only
        // behavior. Never include file contents or low-level errors in diagnostics.
        return null;
    } finally {
        await handle?.close().catch(() => {});
    }
}
