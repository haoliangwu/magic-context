import { copyFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

/**
 * Place a models.dev catalogue where OpenCode caches it inside a throwaway host
 * cache directory. OpenCode 1 builds its model metadata from this file, and Magic
 * Context reads the same file on hosts whose own model metadata has no temperature
 * flag. The source is copied, so the host never opens the operator's own cache.
 */
export function seedModelsCatalog(cacheDir: string, source: string): string {
    const target = join(cacheDir, "opencode", "models.json");
    mkdirSync(join(cacheDir, "opencode"), { recursive: true });
    copyFileSync(source, target);
    return target;
}
