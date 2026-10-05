#!/usr/bin/env bun
// timeout 600 bun packages/plugin/scripts/perf-audit/pi-wire-compare.ts [baseline]
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
interface PerfRunReport {
 passes: { inputMessages: number; tagRowsHash: string; tagRows: number }[];
}

const repo = resolve(import.meta.dir, "../../../..");
const baseline = process.argv[2] ?? "ee9d82912cd8105322672a1f5dd1bbb7172a2f46";
const root = mkdtempSync(join(tmpdir(), "mc-pi-wire-compare-"));
async function run(args: string[], cwd = repo) {
 const child = Bun.spawn(args, { cwd, stdout: "inherit", stderr: "inherit" });
 const code = await child.exited;
 if (code !== 0) throw new Error(`${args[0]} exited ${code}`);
}
try {
 console.log(`Bun ${Bun.version}; exact serialized Pi arrays and persisted tag parity, baseline ${baseline}`);
 const beforeRoot = join(root, "baseline");
 mkdirSync(beforeRoot);
 const archive = join(root, "baseline.tar");
 await run(["git", "archive", "--format=tar", `--output=${archive}`, baseline]);
 await run(["tar", "-xf", archive, "-C", beforeRoot]);
 for (const directory of ["node_modules", "packages/pi-plugin/node_modules", "packages/plugin/node_modules"]) {
  symlinkSync(join(repo, directory), join(beforeRoot, directory), "dir");
 }
 const reports: PerfRunReport[] = [];
 for (const [name, directory] of [["before", beforeRoot], ["after", repo]]) {
  const output = join(root, `${name}.json`);
  await run([process.execPath, join(directory!, "packages/pi-plugin/scripts/experiments/perf/run.ts"), "--messages", "60000", "--points", "1000,10000,60000", "--repeat-final", "1", "--output", output, "--wire-output", join(root, name!)], join(directory!, "packages/pi-plugin"));
  reports.push(await Bun.file(output).json());
 }
 const before = reports[0]!; const after = reports[1]!;
 if (before.passes.length !== 4 || after.passes.length !== 4) throw new Error("expected four comparison passes");
 for (let index = 0; index < 4; index++) {
  const oldWire = await Bun.file(join(root, `before-${index + 1}.json`)).text();
  const newWire = await Bun.file(join(root, `after-${index + 1}.json`)).text();
  if (oldWire !== newWire) throw new Error(`pass ${index + 1}: exact Pi wire changed`);
  const oldPass = before.passes[index]!; const newPass = after.passes[index]!;
  if (oldPass.tagRowsHash !== newPass.tagRowsHash || oldPass.tagRows !== newPass.tagRows) throw new Error(`pass ${index + 1}: persisted tag state changed`);
  console.log(`pass ${index+1}: messages=${newPass.inputMessages} bytes=${Buffer.byteLength(newWire)} exactSHA256=${createHash("sha256").update(newWire).digest("hex")} tags=${newPass.tagRows} unchanged`);
 }
 console.log("4 passes: zero exact-wire diffs, zero persisted-tag diffs");
} finally { rmSync(root, { recursive: true, force: true }); }
