import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { piThinkingManifest, toolDescriptionManifest } from "./config-manifests";

const target = resolve(import.meta.dir, "../src/generated");
mkdirSync(target, { recursive: true });
for (const [name, value] of Object.entries({ "tool-descriptions": toolDescriptionManifest(), "pi-thinking-levels": await piThinkingManifest() })) {
  writeFileSync(resolve(target, `${name}.json`), `${JSON.stringify(value, null, 2)}\n`);
  console.log(`Generated ${name}: ${Object.keys(value).length} entries`);
}
// Run Biome through its JavaScript launcher with Bun's own timeout. The GNU `timeout`
// command and the extensionless `.bin/biome` shim don't exist on Windows runners.
const biome = require.resolve("@biomejs/biome/bin/biome");
const format = Bun.spawnSync([process.execPath, biome, "format", "--write", target], {
  cwd: resolve(import.meta.dir, ".."),
  stdout: "inherit",
  stderr: "inherit",
  timeout: 30_000,
  windowsHide: true,
});
if (format.exitCode !== 0) throw new Error("Could not format generated config manifests");
