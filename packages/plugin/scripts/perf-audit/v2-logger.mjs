import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "mc-perf-v2-log-"));
for (const key of [
    "HOME",
    "XDG_CONFIG_HOME",
    "XDG_DATA_HOME",
    "XDG_STATE_HOME",
    "XDG_CACHE_HOME",
]) {
    process.env[key] = join(root, key);
    mkdirSync(process.env[key], { recursive: true });
}
process.env.MAGIC_CONTEXT_STORAGE_DIR = join(root, "mc");
const { flushLogger, getLogFilePath, log } = await import("../../src/shared/logger");

const lines = () => readFileSync(getLogFilePath(), "utf8").trimEnd().split("\n").length;
function measure(label, expectedLines, run) {
    run();
    const before = lines();
    const start = performance.now();
    for (let i = 0; i < 100; i++) run();
    const elapsed = performance.now() - start;
    const written = lines() - before;
    assert.equal(written, expectedLines * 100, "The real logger did not write the measured lines");
    console.log(
        `${label}: ${(elapsed / 100).toFixed(3)} ms/pass, ${written} actual lines (100 passes)`,
    );
}

console.log(`bun=${Bun.version} platform=${process.platform} private log root=${root}`);
try {
    measure("V2-12 50 real log lines including synchronous buffer flush", 50, () => {
        for (let i = 0; i < 50; i++) log("[transform] timing /tmp/example 1.25 ms");
        flushLogger();
    });
    const objects = Array.from({ length: 50 }, () => ({
        path: "/tmp/example",
        message: "safe diagnostic text",
    }));
    measure("V2-12 50-object log payload including synchronous flush", 1, () => {
        log("[transform] timings", objects);
        flushLogger();
    });
} finally {
    flushLogger();
    rmSync(root, { recursive: true, force: true });
}
