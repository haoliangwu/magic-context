import { execFileSync } from "node:child_process";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createTestTempDir } from "../../plugin/src/shared/test-temp-dir";

let tree: string | undefined;

/** Manual capture/host-probe support only; tests must use committed fixtures. */
export function temporalLegacyTree(repositoryRoot?: string): string {
    if (tree) return tree;
    const repository = repositoryRoot ?? resolve(import.meta.dir, "../../..");
    const root = createTestTempDir("temporal-legacy-code-").dir;
    const archive = execFileSync(
        "git",
        [
            "archive",
            "114e9ff617a1f492b1baf546b52a93585eb4cfeb",
            "packages/plugin",
            "packages/pi-plugin",
            "packages/retina-local-fs",
        ],
        { cwd: repository, timeout: 30_000, maxBuffer: 64 * 1024 * 1024 },
    );
    const path = join(root, "source.tar");
    writeFileSync(path, archive);
    execFileSync("tar", ["-xf", path, "-C", root], { timeout: 30_000 });
    symlinkSync(join(repository, "node_modules"), join(root, "node_modules"), "dir");
    for (const name of ["plugin", "pi-plugin"]) {
        mkdirSync(join(root, "packages", name), { recursive: true });
        symlinkSync(
            join(repository, "packages", name, "node_modules"),
            join(root, "packages", name, "node_modules"),
            "dir",
        );
    }
    tree = root;
    return root;
}
