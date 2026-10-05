import { spawn } from "node:child_process";
import { readdirSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));

const SPAWN_SYNC_TESTS = new Set([
    "src/commands/doctor-repair-db.test.ts",
    "src/lib/omp-helpers.test.ts",
    "src/lib/opencode-helpers.test.ts",
    "src/lib/pi-helpers.test.ts",
]);

function findTestFiles(directory: string, relativeDirectory: string): string[] {
    return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
        const relativePath = `${relativeDirectory}/${entry.name}`;
        if (entry.isDirectory()) return findTestFiles(resolve(directory, entry.name), relativePath);
        return entry.isFile() && entry.name.endsWith(".test.ts") ? [relativePath] : [];
    });
}

const testFiles = findTestFiles(resolve(packageRoot, "src"), "src").sort();
const regularTestFiles = testFiles.filter((file) => !SPAWN_SYNC_TESTS.has(file));
const isolatedTestFiles = testFiles.filter((file) => SPAWN_SYNC_TESTS.has(file));

if (isolatedTestFiles.length !== SPAWN_SYNC_TESTS.size) {
    const missing = [...SPAWN_SYNC_TESTS].filter((file) => !isolatedTestFiles.includes(file));
    console.error(`Spawn-sensitive CLI test file is missing: ${missing.join(", ")}`);
    process.exit(1);
}

function runTestFiles(files: string[]): Promise<number> {
    return new Promise((resolveExitCode) => {
        const child = spawn(process.execPath, ["test", ...process.argv.slice(2), ...files], {
            windowsHide: true,
            cwd: packageRoot,
            env: process.env,
            stdio: "inherit",
        });
        child.once("error", () => resolveExitCode(1));
        child.once("exit", (code) => resolveExitCode(code ?? 1));
    });
}

// Bun 1.3.14 can lose private event-loop poll references while spawnSync waits
// (oven-sh/bun#34069). Every later synchronous probe in that VM then hangs.
// Keep explicitly marked real-subprocess integration coverage, but give each
// spawn-heavy file a fresh VM until the upstream event-loop accounting fix
// (oven-sh/bun#37754) ships.
let exitCode = await runTestFiles(regularTestFiles);
if (exitCode === 0) {
    for (const file of isolatedTestFiles) {
        exitCode = await runTestFiles([file]);
        if (exitCode !== 0) break;
    }
}

if (exitCode !== 0) console.error(`1 fail (CLI test subprocess exited ${exitCode})`);
process.exit(exitCode);
