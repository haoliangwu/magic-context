import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("marker-seam full-tool replay preserves the reasoning-only assistant on defer", () => {
    const output = mkdtempSync(join(tmpdir(), "ckios-marker-replay-"));
    try {
        execFileSync(process.execPath, [join(import.meta.dir, "ckios-reasoning-only-probe.ts"), output], {
            env: { ...process.env, MC_PROBE_LANE: "marker-drops", MC_SPECIMEN_DIR: "" },
            timeout: 180_000,
            stdio: "pipe",
        });
        const bodies = JSON.parse(readFileSync(join(output, "marker-drops-bodies.json"), "utf8"));
        expect(bodies).toHaveLength(2);
        const [a, b] = bodies.map((body: { messages: unknown[] }) => body.messages);
        const target = (messages: unknown[]) => messages.findIndex(message => JSON.stringify(message).includes("CKIOS_REASONING_ONLY"));
        expect(target(a)).toBeGreaterThan(0);
        expect(target(b)).toBe(target(a));
        const sha = (messages: unknown[]) => createHash("sha256").update(JSON.stringify(messages, (key, value) => key === "cache_control" ? undefined : value)).digest("hex");
        expect(sha(b.slice(0, a.length))).toBe(sha(a));
        const log = readFileSync(join(output, "marker-drops.log"), "utf8");
        expect(log).toContain("decision=execute");
        expect(log).toContain("compaction-marker drain: applied at ordinal 4");
        expect(log.lastIndexOf("decision=defer")).toBeGreaterThan(log.lastIndexOf("decision=execute"));
        console.log(`CKIOS marker replay prefix sha256=${sha(a)} messages=${a.length}`);
    } finally {
        rmSync(output, { recursive: true, force: true });
    }
}, 240_000);

// Replaying a dropped tool can delete the row used to locate the prefix cutoff.
// The immutable source order still proves which surviving rows precede that cutoff.
test("dropped marker boundary must not advance before the served prefix is trimmed", () => {
    const output = mkdtempSync(join(tmpdir(), "ckios-dropped-boundary-"));
    try {
        execFileSync(process.execPath, [join(import.meta.dir, "ckios-reasoning-only-probe.ts"), output], {
            env: { ...process.env, MC_PROBE_LANE: "marker-dropped-boundary", MC_SPECIMEN_DIR: "" },
            timeout: 180_000, stdio: "pipe",
        });
        const bodies = JSON.parse(readFileSync(join(output, "marker-dropped-boundary-bodies.json"), "utf8"));
        expect(bodies).toHaveLength(2);
        const [a, b] = bodies.map((body: { messages: unknown[] }) => body.messages);
        expect(JSON.stringify(a.slice(0, 4))).not.toContain("[dropped §3§]");
        const sha = (messages: unknown[]) => createHash("sha256").update(JSON.stringify(messages, (key, value) => key === "cache_control" ? undefined : value)).digest("hex");
        const normalized = (value: unknown) => JSON.stringify(value, (key, item) => key === "cache_control" ? undefined : item);
        const firstDivergence = Array.from({ length: a.length }, (_, i) => i).find(i => normalized(a[i]) !== normalized(b[i])) ?? -1;
        console.log(`MARKER_GATE dropped-boundary A=${sha(a)} B_prefix=${sha(b.slice(0, a.length))} first_divergence=${firstDivergence}`);
        expect(sha(b.slice(0, a.length))).toBe(sha(a));
    } finally { rmSync(output, { recursive: true, force: true }); }
}, 240_000);
