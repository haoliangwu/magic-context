import { describe, expect, test } from "bun:test";
import { rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createTestTempDirFromPath } from "../../../shared/test-temp-dir";

import { validateSmartNoteHttpUrl } from "./ssrf-guard";

const here = path.dirname(fileURLToPath(import.meta.url));

describe("smart-note SSRF guard runtime parity", () => {
    test("Bun and Node classify public/private DNS the same way", async () => {
        const bunAllowed = await validateSmartNoteHttpUrl("https://example.test/", {
            signal: new AbortController().signal,
            resolver: { lookup: async () => [{ address: "93.184.216.34", family: 4 }] },
        }).then(
            () => true,
            () => false,
        );
        const bunBlocked = await validateSmartNoteHttpUrl("https://example.test/", {
            signal: new AbortController().signal,
            resolver: {
                lookup: async () => [
                    { address: "93.184.216.34", family: 4 },
                    { address: "10.0.0.1", family: 4 },
                ],
            },
        }).then(
            () => false,
            () => true,
        );

        const dir = await createTestTempDirFromPath(path.join(tmpdir(), "mc-ssrf-parity-"));
        try {
            const result = await Bun.build({
                entrypoints: [path.join(here, "ssrf-guard.ts")],
                outdir: dir,
                target: "node",
                format: "esm",
            });
            expect(result.success).toBe(true);
            const bundled = result.outputs[0]?.path;
            expect(typeof bundled).toBe("string");
            const bundledPath = bundled as string;
            const script = path.join(dir, "check.mjs");
            await writeFile(
                script,
                `import { validateSmartNoteHttpUrl } from ${JSON.stringify(`file://${bundledPath}`)};
const signal = new AbortController().signal;
const allowed = await validateSmartNoteHttpUrl('https://example.test/', { signal, resolver: { lookup: async () => [{ address: '93.184.216.34', family: 4 }] } }).then(() => true, () => false);
const blocked = await validateSmartNoteHttpUrl('https://example.test/', { signal, resolver: { lookup: async () => [{ address: '93.184.216.34', family: 4 }, { address: '10.0.0.1', family: 4 }] } }).then(() => false, () => true);
console.log(JSON.stringify({ allowed, blocked }));
`,
                "utf8",
            );
            const proc = Bun.spawn(["node", script], {
                stdout: "pipe",
                stderr: "pipe",
                windowsHide: true,
            });
            const [stdout, stderr, exitCode] = await Promise.all([
                new Response(proc.stdout).text(),
                new Response(proc.stderr).text(),
                proc.exited,
            ]);
            expect(stderr).toBe("");
            expect(exitCode).toBe(0);
            expect(JSON.parse(stdout)).toEqual({ allowed: bunAllowed, blocked: bunBlocked });
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    });
});
