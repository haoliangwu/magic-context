import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { join } from "node:path";

test("health sampler schedules requests even while the rehearsal driver is busy", async () => {
    const server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch: () => new Response("healthy"),
    });
    const sampler = spawn(
        "timeout",
        [
            "30",
            process.execPath,
            join(import.meta.dir, "migration-batch-health-probe.mjs"),
            server.url.href,
            "{}",
        ],
        { stdio: ["pipe", "pipe", "pipe"] },
    );
    const samples: Array<{ wallStarted: number; status?: number }> = [];
    let output = "",
        errors = "";
    let markPrimed!: () => void;
    const primed = new Promise<void>((done) => {
        markPrimed = done;
    });
    sampler.stdout.on("data", (data) => {
        output += String(data);
        let newline;
        while ((newline = output.indexOf("\n")) >= 0) {
            const message = JSON.parse(output.slice(0, newline));
            output = output.slice(newline + 1);
            if (message.type === "primed") markPrimed();
            else samples.push(message);
        }
    });
    sampler.stderr.on("data", (data) => {
        errors += String(data);
    });
    const closed = new Promise<number | null>((done) => sampler.once("close", done));
    try {
        const first = await Promise.race([primed.then(() => true), closed.then(() => false)]);
        expect(first).toBe(true);
        const blockedAt = Date.now();
        // Synchronous SDK/module loading can occupy the driver's event loop.
        // The child must continue issuing probes instead of inheriting that gap.
        const deadline = performance.now() + 650;
        while (performance.now() < deadline) {
            // Deliberately occupy the driver, not the independent sampler.
        }
        const unblockedAt = Date.now();
        sampler.stdin.end("stop\n");
        expect(await closed, errors).toBe(0);
        expect(
            samples.some((s) => s.wallStarted > blockedAt && s.wallStarted < unblockedAt),
        ).toBe(true);
        expect(samples.every((s) => s.status === 200)).toBe(true);
    } finally {
        if (!sampler.stdin.destroyed) sampler.stdin.end("stop\n");
        server.stop(true);
    }
});

// Opt in only with a permitted full-size backup clone. Ordinary package tests
// must neither require that specimen nor discover any developer's real stores.
test.skipIf(!process.env.MIGRATION_REHEARSAL_ROOT)(
    "full-size host preflight validates the read-only v94 rehearsal corpus",
    async () => {
        const child = spawn(
            "timeout",
            [
                "60",
                process.execPath,
                join(import.meta.dir, "migration-batch-hosts.mjs"),
                process.env.MIGRATION_REHEARSAL_ROOT!,
                "--skip-rehearsal",
                "--full-size-health",
                // Skip both run loops; this check exercises only the preflight.
                "--health-only",
                "--wire-only",
            ],
            {
                env: { ...process.env, TMPDIR: process.env.MIGRATION_REHEARSAL_TMPDIR! },
                stdio: ["ignore", "pipe", "pipe"],
            },
        );
        let output = "";
        child.stdout.on("data", (data) => {
            output += String(data);
        });
        child.stderr.on("data", (data) => {
            output += String(data);
        });
        const code = await new Promise<number | null>((done) => child.once("close", done));
        expect(code, output).toBe(0);
    },
);
