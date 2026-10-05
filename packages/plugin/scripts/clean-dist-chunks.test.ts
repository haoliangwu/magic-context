import { afterEach, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { cleanupTestTempDir, createTestTempDir } from "../src/shared/test-temp-dir";

const repoRoot = resolve(import.meta.dir, "../../..");
const script = join(repoRoot, "scripts/clean-dist-chunks.mjs");
const dirs: string[] = [];

function scratch(): string {
    const { dir } = createTestTempDir("mc-clean-dist-chunks-");
    dirs.push(dir);
    return dir;
}

function run(...args: string[]) {
    return spawnSync(process.execPath, [script, ...args], { encoding: "utf8", windowsHide: true, timeout: 10_000 });
}

afterEach(() => {
    for (const dir of dirs.splice(0)) cleanupTestTempDir(dir);
});

describe("clean-dist-chunks", () => {
    it("succeeds on a clean checkout where nothing matches", () => {
        const dist = join(scratch(), "dist");
        mkdirSync(dist);
        const result = run(dist, "index.js");
        expect(result.status).toBe(0);
    });

    it("succeeds when the dist directory does not exist yet", () => {
        const result = run(join(scratch(), "missing"), "index.js");
        expect(result.status).toBe(0);
    });

    it("removes the named entries and week-old split chunks, and nothing else", () => {
        const dist = join(scratch(), "dist");
        mkdirSync(join(dist, "v2"), { recursive: true });
        for (const name of ["index.js", "index-a1b2.js", "chunk-x9.js", "keep.js", "keep.d.ts", "style-a.css"]) {
            writeFileSync(join(dist, name), "");
        }
        const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
        for (const name of ["index-a1b2.js", "chunk-x9.js"]) utimesSync(join(dist, name), eightDaysAgo, eightDaysAgo);
        writeFileSync(join(dist, "v2", "server-a1.js"), "");
        const result = run(dist, "index.js");
        expect(result.status).toBe(0);
        expect(readdirSync(dist).sort()).toEqual(["keep.d.ts", "keep.js", "style-a.css", "v2"]);
        // Only the named directory is cleaned, never a subdirectory.
        expect(existsSync(join(dist, "v2", "server-a1.js"))).toBe(true);
    });

    // A running OpenCode or Pi process may still lazily import a chunk from the
    // build it loaded, so a rebuild must not delete recent chunks.
    it("keeps recent split chunks that a running host may still import", () => {
        const dist = join(scratch(), "dist");
        mkdirSync(dist);
        for (const name of ["index.js", "index-old1.js", "read-session-chunk-old2.js"]) {
            writeFileSync(join(dist, name), "");
        }
        const result = run(dist, "index.js");
        expect(result.status).toBe(0);
        expect(readdirSync(dist).sort()).toEqual(["index-old1.js", "read-session-chunk-old2.js"]);
    });
});

// Bun's script shell on Windows expands an unquoted glob itself and aborts on an
// empty match, so a clean build failed there. Package scripts delete build
// outputs through clean-dist-chunks.mjs instead of a shell glob.
describe("package build scripts", () => {
    it("package clean preserves chunks needed by running hosts", () => {
        for (const pkg of ["plugin", "pi-plugin"]) {
            const root = scratch();
            const dist = join(root, "packages", pkg, "dist");
            mkdirSync(dist, { recursive: true });
            mkdirSync(join(root, "scripts"));
            writeFileSync(join(root, "scripts", "clean-dist-chunks.mjs"), readFileSync(script));
            writeFileSync(join(dist, "index.js"), "old entry");
            writeFileSync(join(dist, "index-running.js"), "old lazy chunk");
            const command = JSON.parse(readFileSync(join(repoRoot, "packages", pkg, "package.json"), "utf8")).scripts.clean;
            const result = spawnSync(process.execPath, ["exec", command], {
                cwd: join(root, "packages", pkg), encoding: "utf8", timeout: 10_000,
            });
            expect(result.status).toBe(0);
            expect(readFileSync(join(dist, "index-running.js"), "utf8")).toBe("old lazy chunk");
            expect(existsSync(join(dist, "index.js"))).toBe(false);
        }
    });

    it("restart-window merges distributions without deleting a running generation", () => {
        if (process.platform === "win32") return; // The deployment script requires Bash and rsync.
        const root = scratch();
        const repo = join(root, "repo");
        const source = join(root, "prebuilt");
        mkdirSync(join(repo, "scripts"), { recursive: true });
        writeFileSync(join(repo, "scripts", "clean-dist-chunks.mjs"), readFileSync(script));
        const expired = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
        for (const pkg of ["plugin", "pi-plugin"]) {
            const dist = join(repo, "packages", pkg, "dist");
            const incoming = join(source, "packages", pkg, "dist");
            mkdirSync(join(dist, "v2"), { recursive: true });
            mkdirSync(incoming, { recursive: true });
            writeFileSync(join(dist, "index-running.js"), "running lazy chunk");
            writeFileSync(join(dist, "index-expired.js"), "expired");
            utimesSync(join(dist, "index-expired.js"), expired, expired);
            writeFileSync(join(dist, "v2", "server-running.js"), "running v2 chunk");
            writeFileSync(join(incoming, "index.js"), "new entry");
            writeFileSync(join(incoming, "index-new.js"), "new lazy chunk");
            // Copying a prebuilt checkout preserves timestamps. Never prune a
            // newly copied chunk that its entry point still references.
            utimesSync(join(incoming, "index-new.js"), expired, expired);
        }
        // Execute only the real dist-copy block, never deployment preflight, stores,
        // migrations or service control. This exercises the production command,
        // rather than a safe proxy for the formerly destructive rsync operation.
        const deployment = readFileSync(join(repoRoot, "scripts/restart-window.sh"), "utf8");
        const block = deployment.match(/say "swapping in[^\n]*\n([\s\S]*?)\n\(cd "\$REPO"/);
        expect(block).not.toBeNull();
        const result = spawnSync("bash", ["-euc", `post_fail() { exit 1; }; ${block![1]}`], {
            env: { ...process.env, REPO: repo, DISTS: source }, encoding: "utf8", timeout: 10_000,
        });
        expect(result.status).toBe(0);
        for (const pkg of ["plugin", "pi-plugin"]) {
            const dist = join(repo, "packages", pkg, "dist");
            expect(readFileSync(join(dist, "index-running.js"), "utf8")).toBe("running lazy chunk");
            expect(readFileSync(join(dist, "v2", "server-running.js"), "utf8")).toBe("running v2 chunk");
            expect(readFileSync(join(dist, "index.js"), "utf8")).toBe("new entry");
            expect(readFileSync(join(dist, "index-new.js"), "utf8")).toBe("new lazy chunk");
            expect(existsSync(join(dist, "index-expired.js"))).toBe(false);
        }
    });

    it("Bun CLI and API builds keep unrelated split chunks in an existing outdir", async () => {
        const root = scratch();
        const dist = join(root, "dist");
        mkdirSync(dist);
        const entry = join(root, "entry.ts");
        const lazy = join(root, "lazy.ts");
        writeFileSync(entry, 'export const load = () => import("./lazy.ts");');
        writeFileSync(lazy, 'export const generation = "first";');
        const args = ["build", entry, "--outdir", dist, "--target", "node", "--format", "esm", "--splitting"];
        expect(spawnSync(process.execPath, args, { encoding: "utf8", timeout: 10_000 }).status).toBe(0);
        const firstChunks = readdirSync(dist).filter((name) => name !== "entry.js");
        expect(firstChunks.length).toBeGreaterThan(0);
        const contents = firstChunks.map((name) => readFileSync(join(dist, name), "utf8"));
        writeFileSync(lazy, 'export const generation = "second";');
        expect(spawnSync(process.execPath, args, { encoding: "utf8", timeout: 10_000 }).status).toBe(0);
        writeFileSync(lazy, 'export const generation = "third";');
        const built = await Bun.build({ entrypoints: [entry], outdir: dist, target: "node", format: "esm", splitting: true });
        expect(built.success).toBe(true);
        expect(firstChunks.map((name) => readFileSync(join(dist, name), "utf8"))).toEqual(contents);
    });

    it("never delete with a shell glob", () => {
        const offenders: string[] = [];
        for (const pkg of ["package.json", "packages/plugin/package.json", "packages/pi-plugin/package.json", "packages/cli/package.json"]) {
            const scripts = JSON.parse(readFileSync(join(repoRoot, pkg), "utf8")).scripts ?? {};
            for (const [name, command] of Object.entries<string>(scripts)) {
                if (/\brm\b[^&|;]*\*/.test(command)) offenders.push(`${pkg} ${name}`);
            }
        }
        expect(offenders).toEqual([]);
    });
});
