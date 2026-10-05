/**
 * Run with: timeout 1200 bun packages/plugin/scripts/perf-audit/hr-replay-isolated.ts <before-ref> <after-ref>
 * Hold the existing replay instrument constant, adding only an fd inventory after
 * each prompt. Both refs still run the repository's real host and wire serializer.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

console.log(`Bun ${Bun.version}`);
const repo = resolve(import.meta.dir, "../../../..");
const root = join(tmpdir(), "magic-context", "perf-hr");
mkdirSync(root, { recursive: true });
const runner = mkdtempSync(join(root, "replay-instrument-"));
const source = join(repo, "packages/e2e-tests/scripts/pure-replay-differential.ts");
const inventory = join(root, "replay-isolation.jsonl");
let text = readFileSync(source, "utf8");
function replace(before: string, after: string): void {
    if (!text.includes(before)) throw new Error(`Replay instrument anchor changed: ${before}`);
    text = text.replace(before, after);
}
replace('const REPO_ROOT = resolve(dirname(SCRIPT_PATH), "../../..");',
    `const REPO_ROOT = Bun.argv.includes("--single-ref") ? resolve(dirname(SCRIPT_PATH), "../../..") : ${JSON.stringify(repo)};`);
replace("const harness = await TestHarness.create(options);", `const harness = await TestHarness.create(options);
    const inspectAuditHost = () => {
        const fixtureRoot = realpathSync(join(harness.opencode.env.dataDir, ".."));
        const files = execFileSync("lsof", ["-p", String(harness.opencode.pid), "-Fn"], { encoding: "utf8", timeout: 30000 })
            .split("\\n").filter((line) => /\\.db(?:-wal|-shm)?$/.test(line));
        if (!files.length || files.some((file) => !file.startsWith("n" + fixtureRoot + "/")))
            throw new Error("replay host database handle escaped the throwaway fixture: " + JSON.stringify(files));
        writeFileSync(${JSON.stringify(inventory)}, JSON.stringify({ pid: harness.opencode.pid, fixtureRoot, files }) + "\\n", { flag: "a" });
    };`);
replace("sendPrompt: (sessionId: string, text: string) =>\n\t\t\t\tharness.sendPrompt(sessionId, text, options),",
    `sendPrompt: async (sessionId: string, text: string) => {
                const result = await harness.sendPrompt(sessionId, text, options);
                inspectAuditHost();
                return result;
            },`);
const instrument = join(runner, "pure-replay-differential.ts");
try {
    writeFileSync(instrument, text);
    const child = spawnSync(process.execPath, [instrument, "--ts-only", ...process.argv.slice(2)], {
        cwd: repo, stdio: "inherit", timeout: 1_100_000,
    });
    if (child.error) throw child.error;
    if (child.status !== 0) throw new Error(`Replay comparison exited ${child.status}`);
    console.log(`Host fd inventory: ${inventory}`);
} finally { rmSync(runner, { recursive: true, force: true }); }
