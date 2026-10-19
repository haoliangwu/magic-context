import { expect, it } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

for (const [name, url, script, entry] of [
    [
        "OpenCode 1",
        new URL("../../../package.json", import.meta.url),
        "build",
        "src/features/magic-context/compaction-marker-candidates-worker.ts",
    ],
    [
        "OpenCode 2",
        new URL("../../../package.json", import.meta.url),
        "build:v2",
        "src/features/magic-context/compaction-marker-candidates-worker.ts",
    ],
    [
        "Pi",
        new URL("../../../../pi-plugin/package.json", import.meta.url),
        "build",
        "../plugin/src/features/magic-context/compaction-marker-candidates-worker.ts",
    ],
] as const) {
    it(`${name} build ships the independent marker candidate worker`, () => {
        const manifest = JSON.parse(readFileSync(url, "utf8")) as {
            scripts: Record<string, string>;
        };
        expect(manifest.scripts[script]?.split(/\s+/)).toContain(entry);
    });
}

it("a built bundle missing its marker worker logs once and visibly defers without scanning or deleting", async () => {
    const root = join(tmpdir(), "magic-context", `marker-missing-worker-${crypto.randomUUID()}`);
    mkdirSync(root, { recursive: true });
    const harness = join(root, "harness.ts");
    const feature = new URL("./compaction-marker-candidates.ts", import.meta.url).pathname;
    const sqlite = new URL("../../shared/sqlite.ts", import.meta.url).pathname;
    const logger = new URL("../../shared/logger.ts", import.meta.url).pathname;
    writeFileSync(
        harness,
        `import {prepareMarkerCandidateBasis,readMarkerCandidateBasis} from ${JSON.stringify(feature)};
        import {Database} from ${JSON.stringify(sqlite)};

        import {flushLogger} from ${JSON.stringify(logger)};
        const db=new Database(process.env.CASE_DB);db.exec('CREATE TABLE message(id TEXT PRIMARY KEY,session_id TEXT,data TEXT)');
        db.prepare('INSERT INTO message VALUES (?,?,?)').run('legacy','s','{"summary":true,"finish":"stop"}');
        for(let attempt=0;attempt<2;attempt++) {
            const ready=await prepareMarkerCandidateBasis(db,'s');
            if(ready||readMarkerCandidateBasis(db,'s'))throw Error('missing worker must not certify candidates');
        }
        if((db.prepare('SELECT count(*) AS n FROM message').get()).n!==1)throw Error('missing worker deleted state');
        flushLogger();db.close();console.log('visible deferral, retained 1 row');`,
    );
    try {
        const worker = new URL("./compaction-marker-candidates-worker.ts", import.meta.url)
            .pathname;
        const build = await Bun.build({
            entrypoints: [harness, worker],
            outdir: root,
            naming: "[name].js",
            target: "node",
            format: "esm",
            splitting: true,
            define: { "process.env.NODE_ENV": '"production"' },
            external: ["bun:sqlite", "node:sqlite"],
        });
        expect(build.success).toBe(true);
        const missing = join(root, "compaction-marker-candidates-worker.js");
        rmSync(missing);
        const logPath = join(root, "marker.log");
        const child = Bun.spawn([process.execPath, join(root, "harness.js")], {
            stdout: "pipe",
            stderr: "pipe",
            windowsHide: true,
            env: {
                ...process.env,
                NODE_ENV: "production",
                CASE_DB: join(root, "fixture.db"),
                MAGIC_CONTEXT_LOG_PATH: logPath,
            },
        });
        const [exit, out, err] = await Promise.all([
            child.exited,
            new Response(child.stdout).text(),
            new Response(child.stderr).text(),
        ]);
        expect(exit, err).toBe(0);
        expect(out).toContain("visible deferral, retained 1 row");
        const lines = readFileSync(logPath, "utf8")
            .split("\n")
            .filter((line) =>
                line.includes("[ERROR] compaction-marker: candidate worker unavailable"),
            );
        expect(lines).toHaveLength(1);
        const visiblePath =
            process.env.HOME && missing.startsWith(`${process.env.HOME}/`)
                ? `~${missing.slice(process.env.HOME.length)}`
                : missing;
        expect(lines[0]).toContain(visiblePath);
        expect(lines[0]).toContain("file missing");
        expect(lines[0]).toContain("marker unchanged, advancement deferred");
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});
