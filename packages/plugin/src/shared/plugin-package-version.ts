import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE_NAME = "@cortexkit/opencode-magic-context";

let cachedVersion: string | null | undefined;

/**
 * Version of the Magic Context package this code was loaded from.
 *
 * The server and the TUI each call this from their own loaded copy, and the
 * status RPC carries the server's answer to the TUI. After an update the two
 * can differ (OpenCode keeps running the copy it started with), and comparing
 * the two values is how the status dialog tells the user to restart.
 *
 * Found by walking up from this module to the nearest `package.json` carrying
 * the package's name, which works for the source tree, the built `dist/`
 * bundle and an npm cache install alike. Null when no such file is readable.
 */
export function pluginPackageVersion(moduleUrl: string = import.meta.url): string | null {
    const useCache = moduleUrl === import.meta.url;
    if (useCache && cachedVersion !== undefined) return cachedVersion;
    let found: string | null = null;
    try {
        let directory = dirname(fileURLToPath(moduleUrl));
        for (let depth = 0; depth < 10; depth++) {
            const candidate = join(directory, "package.json");
            if (existsSync(candidate)) {
                const parsed: unknown = JSON.parse(readFileSync(candidate, "utf8"));
                if (
                    typeof parsed === "object" &&
                    parsed !== null &&
                    "name" in parsed &&
                    parsed.name === PACKAGE_NAME &&
                    "version" in parsed &&
                    typeof parsed.version === "string"
                ) {
                    found = parsed.version;
                    break;
                }
            }
            const parent = dirname(directory);
            if (parent === directory) break;
            directory = parent;
        }
    } catch {
        // An unreadable or unparsable manifest leaves the version unknown.
    }
    if (useCache) cachedVersion = found;
    return found;
}
