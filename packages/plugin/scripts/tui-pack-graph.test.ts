import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createTestTempDir } from "../src/shared/test-temp-dir";
import { checkPackedTuiGraph } from "./tui-pack-graph";

test("published TUI runtime import graph is closed over the npm pack list", () => {
    const packageRoot = join(import.meta.dir, "..");
    const pack = spawnSync("npm", ["pack", "--dry-run", "--ignore-scripts", "--json"], {
        cwd: packageRoot,
        encoding: "utf8",
        maxBuffer: 20 * 1024 * 1024,
    });
    if (pack.status !== 0) throw new Error(`npm pack failed: ${pack.stderr}`);
    const packed = JSON.parse(pack.stdout) as Array<{ files: Array<{ path: string }> }>;
    expect(checkPackedTuiGraph(packageRoot, new Set(packed[0]?.files.map(({ path }) => path)))).toBeGreaterThan(0);
});

test("TUI pack graph checks lazy, transitive and re-exported runtime imports but not types", () => {
    const { dir } = createTestTempDir("tui-pack-graph-");
    try {
        mkdirSync(join(dir, "src/tui"), { recursive: true });
        writeFileSync(join(dir, "tui.js"), 'export { default } from "./src/tui/entry.mjs";');
        writeFileSync(join(dir, "src/tui/entry.mjs"), 'export default {}; export async function lazy() { return import("./lazy"); }');
        writeFileSync(join(dir, "src/tui/lazy.ts"), 'import type { Missing } from "./unpacked-type"; export { value } from "./leaf";');
        writeFileSync(join(dir, "src/tui/leaf.ts"), "export const value = 1;");
        const packed = new Set(["tui.js", "src/tui/entry.mjs", "src/tui/lazy.ts", "src/tui/leaf.ts"]);
        expect(checkPackedTuiGraph(dir, packed)).toBe(4);
        packed.delete("src/tui/leaf.ts");
        expect(() => checkPackedTuiGraph(dir, packed)).toThrow("src/tui/lazy.ts imports ./leaf → src/tui/leaf.ts, which is not packed");
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
