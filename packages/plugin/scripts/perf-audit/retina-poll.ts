// Reproducible polling audit; all git repositories and traces live in the
// supplied throwaway root. Run: timeout 120 bun .../retina-poll.ts <root>
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { runProvider } from "@cortexkit/retina-local-fs/provider";

const root = resolve(process.argv[2] ?? "");
if (!process.argv[2]) throw new Error("throwaway root required");
mkdirSync(root, { recursive: true });
const repo = join(root, "repo");
mkdirSync(repo, { recursive: true });
const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
const git = (...args: string[]) => execFileSync(realGit, ["-C", repo, ...args], {
    encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z", GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z" },
}).trim();
if (!existsSync(join(repo, ".git"))) {
    git("init", "--initial-branch=main");
    git("config", "user.name", "Audit");
    git("config", "user.email", "audit@example.invalid");
    writeFileSync(join(repo, "state"), "first");
    git("add", "state");
    git("commit", "-m", "first");
    writeFileSync(join(repo, "state"), "second");
    git("add", "state");
    git("commit", "-m", "second");
}
const base = git("rev-parse", "HEAD~1");
const bin = join(root, "bin");
const trace = join(root, "git.trace");
mkdirSync(bin, { recursive: true });
const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
writeFileSync(join(bin, "git"), `#!/bin/sh\nprintf '%s\\n' "$*" >> ${shellQuote(trace)}\nexec ${shellQuote(realGit)} "$@"\n`, { mode: 0o755 });
const oldPath = process.env.PATH;
process.env.PATH = `${bin}:${oldPath}`;
const config = { kind: "git_commit_after", repo_path: repo, sha: base } as const;
const first = await runProvider({ config, scalar: null }, { now: () => 0 });
writeFileSync(trace, "");
const times: number[] = [];
for (let pass = 0; pass < 30; pass++) {
    const start = performance.now();
    const next = await runProvider({ config, scalar: first.scalar }, { now: () => 0 });
    times.push(performance.now() - start);
    if (next.events.length !== 0 || JSON.stringify(next.scalar) !== JSON.stringify(first.scalar)) throw new Error("steady-state output changed");
}
times.sort((a, b) => a - b);
console.log(JSON.stringify({ bun: Bun.version, polls: times.length, gitProcesses: readFileSync(trace, "utf8").trim().split("\n").length, medianMs: times[15], firstOutput: first }));
process.env.PATH = oldPath;
