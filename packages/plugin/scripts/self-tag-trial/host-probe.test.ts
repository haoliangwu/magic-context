import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// A research probe for the self-tag trial: it boots a real host and takes minutes,
// so it runs only when asked for (MC_SELF_TAG_HOST_PROBE=1) and the pinned host exists.
const requested = process.env.MC_SELF_TAG_HOST_PROBE === "1";
let pinnedHostAvailable = false;
if (requested) {
    try {
        pinnedHostAvailable =
            execFileSync("opencode", ["--version"], { encoding: "utf8", windowsHide: true }).trim() ===
            "1.18.30";
    } catch {
        // The research probe requires an installed OpenCode host, not just Bun.
    }
    if (!pinnedHostAvailable) {
        console.warn("Skipping self-tag host probe: pinned OpenCode 1.18.30 is not available on PATH.");
    }
}

test.skipIf(!requested || !pinnedHostAvailable)("C and D guidance reaches the pinned host and is absent for A", () => {
    const base = join(tmpdir(), "magic-context", "self-tag-trial");
    mkdirSync(base, { recursive: true });
    const output = join(mkdtempSync(join(base, "proof-")), "proof.json");
    execFileSync(process.execPath, [join(import.meta.dir, "host-probe.ts"), output], {
        stdio: "pipe",
        windowsHide: true,
    });
    const proof = JSON.parse(readFileSync(output, "utf8"));
    expect(proof.records.map((r: any) => r.variant)).toEqual(["A", "B", "C", "D"]);
    expect(proof.realModelCalls).toBe(0);
}, 120000);
