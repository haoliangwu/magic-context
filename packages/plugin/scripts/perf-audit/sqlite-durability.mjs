// timeout 120 node packages/plugin/scripts/perf-audit/sqlite-durability.mjs
// timeout 120 bun packages/plugin/scripts/perf-audit/sqlite-durability.mjs
// A controlled commit-cost probe: real shared Bun/Node wrapper, synthetic WAL
// store, 32 fixed-size scalar updates per pass, 9 passes, no auto-checkpoint.
// FULL minus NORMAL estimates the per-commit sync cost, not syscall counts.
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "../../src/shared/sqlite.ts";
import { configureContextDatabasePragmas } from "../../src/shared/sqlite-context-pragmas.ts";

const root = mkdtempSync(join(tmpdir(), "mc-durability-perf-"));
let checks = 0;
try {
    console.log(
        JSON.stringify({
            runtime: process.versions.bun ?? process.version,
            checks: "3 fixtures x 2 policies x 9 passes x 32 commits",
        }),
    );
    for (const n of [1000, 10000, 60000]) {
        const path = join(root, `${n}.db`);
        const db = new Database(path);
        try {
            db.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0");
            const beforePolicy = db.prepare("PRAGMA synchronous").get().synchronous;
            db.exec("CREATE TABLE fixture(id INTEGER PRIMARY KEY, value INTEGER, payload TEXT)");
            const insert = db.prepare("INSERT INTO fixture VALUES (?, 0, ?)");
            db.transaction(() => {
                for (let i = 0; i < n; i++) insert.run(i, "x".repeat(256));
            })();
            const update = db.prepare("UPDATE fixture SET value = value + 1 WHERE id = ?");
            for (const policy of ["FULL", "NORMAL"]) {
                if (policy === "FULL") db.exec("PRAGMA synchronous=FULL");
                else configureContextDatabasePragmas(db);
                const samples = [];
                for (let pass = 0; pass < 9; pass++) {
                    const walBefore = statSync(`${path}-wal`).size;
                    let holdMs = 0;
                    const start = performance.now();
                    for (let i = 0; i < 32; i++) {
                        db.exec("BEGIN IMMEDIATE");
                        const held = performance.now();
                        update.run(i);
                        db.exec("COMMIT");
                        holdMs += performance.now() - held;
                    }
                    samples.push({
                        ms: performance.now() - start,
                        holdMs,
                        commits: 32,
                        walBytes: statSync(`${path}-wal`).size - walBefore,
                    });
                    checks++;
                }
                samples.sort((a, b) => a.ms - b.ms);
                console.log(
                    JSON.stringify({
                        n,
                        policy,
                        beforePolicy,
                        pragma: db.prepare("PRAGMA synchronous").get(),
                        ...samples[4],
                    }),
                );
            }
            if (db.prepare("PRAGMA journal_mode").get().journal_mode !== "wal")
                throw new Error("WAL not active");
            if (db.prepare("PRAGMA synchronous").get().synchronous !== 1)
                throw new Error("NORMAL not active");
        } finally {
            db.close();
        }
    }
    console.log(JSON.stringify({ checks, removed: true }));
} finally {
    rmSync(root, { recursive: true, force: true });
}
