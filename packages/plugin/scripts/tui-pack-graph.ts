import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, relative, resolve } from "node:path";

const SOURCE_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".json"];

/** Check every literal runtime import, including lazy branches, against npm's actual pack list. */
export function checkPackedTuiGraph(packageRoot: string, packedPaths: ReadonlySet<string>): number {
    const visited = new Set<string>();
    const pending = ["tui.js", "src/tui/entry.mjs"];
    while (pending.length > 0) {
        const path = pending.pop();
        if (!path || visited.has(path)) continue;
        if (!packedPaths.has(path)) throw new Error(`TUI import graph: ${path} is not packed`);
        visited.add(path);
        if (extname(path) === ".json") continue;

        const absolutePath = resolve(packageRoot, path);
        const loader = extname(path) === ".tsx" || extname(path) === ".jsx" ? "tsx" : "ts";
        // Bun's scanner erases type-only imports just like the actual TUI loader.
        // The non-literal runtime-registry probe in entry.mjs is host-provided;
        // its literal raw, compiled and v2 fallbacks are all traversed here.
        const imports = new Bun.Transpiler({ loader }).scanImports(readFileSync(absolutePath, "utf8"));
        for (const { path: specifier } of imports) {
            if (!specifier.startsWith(".")) continue;
            const base = resolve(dirname(absolutePath), specifier);
            const candidates = [
                base,
                ...SOURCE_EXTENSIONS.map((extension) => base + extension),
                ...SOURCE_EXTENSIONS.map((extension) => resolve(base, `index${extension}`)),
            ];
            const target = candidates.find((candidate) => existsSync(candidate) && statSync(candidate).isFile());
            if (!target) throw new Error(`TUI import graph: ${path} imports missing ${specifier}`);
            const targetPath = relative(packageRoot, target).replaceAll("\\", "/");
            if (!packedPaths.has(targetPath)) {
                throw new Error(`TUI import graph: ${path} imports ${specifier} → ${targetPath}, which is not packed`);
            }
            pending.push(targetPath);
        }
    }
    return visited.size;
}
