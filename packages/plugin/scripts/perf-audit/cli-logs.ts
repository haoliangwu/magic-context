// Measure the actual doctor log readers on generated fleet logs, without
// discovery of any host log. Run with a throwaway root:
// timeout 120 bun .../cli-logs.ts <root>
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(process.argv[2] ?? "");
if (!process.argv[2]) throw new Error("throwaway root required");
mkdirSync(root, { recursive: true });
// Runtime import avoids pulling CLI sources outside the plugin scripts'
// TypeScript rootDir. The benchmark calls the real exported readers.
const moduleUrl = new URL("../../../cli/src/lib/log-lines.ts", import.meta.url).href;
const { inspectLogFile, readLogLines } = (await import(moduleUrl)) as {
    inspectLogFile: (path: string) => { path: string; exists: boolean; lineCount: number; grammar: string };
    readLogLines: (files: { path: string; exists: boolean }[]) => string[];
};
console.log(`Bun ${Bun.version}`);
for (const count of [1_000, 10_000, 60_000]) {
    const path = join(root, `logs-${count}.log`);
    writeFileSync(path, "2026-01-01T00:00:00.000Z INFO  magic-context.perf: [session=opencode:ses_audit] transform pass=1 duration=42\n".repeat(count));
    const start = performance.now();
    const file = inspectLogFile(path);
    const inspected = performance.now();
    const lines = readLogLines([file]);
    const done = performance.now();
    if (file.lineCount !== count || lines.length !== count || file.grammar !== "fleet-r2") throw new Error("fixture not recognized");
    console.log(JSON.stringify({ count, inspectMs: inspected - start, readSortMs: done - inspected, totalMs: done - start }));
    rmSync(path);
}
