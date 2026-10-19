import { copyFileSync, cpSync, existsSync, symlinkSync, unlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { cleanupE2ETempDir, createE2ETempDir } from "./temp-dir";

/** Copy the built plugin to an isolated test directory without the compaction-marker
 * candidate worker, so tests can exercise behavior when that worker is unavailable. */
export function markerWorkerBundleFixture() {
    const plugin = resolve(import.meta.dir, "../../plugin");
    const root = createE2ETempDir("marker-worker-bundle-");
    try {
        cpSync(join(plugin, "dist"), join(root, "dist"), { recursive: true });
        for (const name of ["package.json", "index.js", "tui.js"]) {
            if (existsSync(join(plugin, name))) copyFileSync(join(plugin, name), join(root, name));
        }
        symlinkSync(join(plugin, "node_modules"), join(root, "node_modules"), "dir");
        const workers = ["dist", "dist/v2"].map((directory) =>
            join(directory, "compaction-marker-candidates-worker.js"),
        );
        for (const worker of workers) unlinkSync(join(root, worker));
        return {
            root,
            entry: join(root, "dist/index.js"),
            restoreWorker() {
                for (const worker of workers) copyFileSync(join(plugin, worker), join(root, worker));
            },
            dispose() {
                cleanupE2ETempDir(root);
            },
        };
    } catch (error) {
        cleanupE2ETempDir(root);
        throw error;
    }
}
