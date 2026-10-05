#!/usr/bin/env bun
// Run the standard replay instrument unchanged except for read-only host
// isolation and exact raw-body observations. No plugin/harness behavior is patched.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    realpathSync,
    rmSync,
    symlinkSync,
    writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const repo = resolve(import.meta.dir, "../../../..");
const root = realpathSync(mkdtempSync(join(repo, ".tx-host-replay-")));
const launcher = join(root, "launcher");
const proofDir = join(root, "proof");
const relative = "packages/e2e-tests/scripts/pure-replay-differential.ts";
const baseline = "ee9d82912cd8105322672a1f5dd1bbb7172a2f46";
const candidate = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
const operatorHome = homedir();

function replaceExactly(source: string, before: string, after: string): string {
    if (source.split(before).length !== 2) throw new Error(`instrument anchor was not unique: ${before}`);
    return source.replace(before, after);
}

try {
    mkdirSync(join(launcher, "packages/e2e-tests/scripts"), { recursive: true });
    mkdirSync(join(root, "tmp"), { recursive: true });
    mkdirSync(join(root, "home"), { recursive: true });
    mkdirSync(proofDir, { recursive: true });
    // Keep archives, imports, installs and host scratch files inside this worktree.
    for (const entry of ["node_modules", "packages/plugin/node_modules", "packages/e2e-tests/node_modules", "packages/retina-local-fs/node_modules"]) {
        const source = join(repo, entry);
        if (existsSync(source)) {
            mkdirSync(resolve(join(launcher, entry), ".."), { recursive: true });
            symlinkSync(source, join(launcher, entry), "dir");
        }
    }
    const env = { ...process.env };
    for (const key of Object.keys(env)) {
        if (key.startsWith("OPENCODE_") || key.startsWith("MC_E2E_") ||
            key === "MAGIC_CONTEXT_DEBUG_ASSERTIONS" || key === "NODE_ENV") delete env[key];
    }
    Object.assign(env, {
        HOME: join(root, "home"),
        XDG_CONFIG_HOME: join(root, "home/config"),
        XDG_DATA_HOME: join(root, "home/data"),
        XDG_CACHE_HOME: join(root, "home/cache"),
        TMPDIR: join(root, "tmp"),
        MC_REPLAY_SCRATCH_ROOT: join(root, "archives"),
        MC_TX_HOST_PROOF_DIR: proofDir,
        MC_TX_OPERATOR_HOME: operatorHome,
        MC_TX_REPO_ROOT: repo,
    });
    const version = execFileSync("opencode", ["--version"], { cwd: launcher, env, encoding: "utf8", timeout: 120_000 }).trim();
    if (!/^1\./.test(version)) throw new Error(`expected OpenCode 1, got ${version}`);
    console.log(`Bun ${Bun.version}; real OpenCode ${version}; baseline=${baseline}; candidate=${candidate}`);

    let source = readFileSync(join(repo, relative), "utf8");
    // The launcher is nested below the real git root. Archive from that root,
    // but let each extracted child keep its own source/import/fixture root.
    source = replaceExactly(source, 'const REPO_ROOT = resolve(dirname(SCRIPT_PATH), "../../..");',
        'const REPO_ROOT = !Bun.argv.includes("--single-ref") && process.env.MC_TX_REPO_ROOT ? process.env.MC_TX_REPO_ROOT : resolve(dirname(SCRIPT_PATH), "../../..");');
    source = replaceExactly(source, "\tsymlinkSync,", "\tstatSync,\n\tsymlinkSync,");
    source = replaceExactly(source, "\tconst harness = await TestHarness.create(options);", `
\tconst harness = await TestHarness.create(options);
\tconst { inspectHostOpenFiles } = await import("../src/host-open-files");
\tlet auditedMainRequests = 0;
\tconst auditHost = () => {
\t\tconst pid = harness.opencode.pid;
\t\tconst fixtureRoot = realpathSync(dirname(harness.opencode.env.configDir));
\t\tconst context = realpathSync(harness.contextDbPath());
\t\tconst opencode = realpathSync(join(harness.opencode.env.dataDir, "opencode/opencode.db"));
\t\tconst proof = inspectHostOpenFiles(pid, fixtureRoot, context);
\t\tconst second = inspectHostOpenFiles(pid, fixtureRoot, opencode);
\t\tconst operator = process.env.MC_TX_OPERATOR_HOME!;
\t\tfor (const inventory of [proof.inventory, second.inventory]) {
\t\t\tfor (const line of inventory.split("\\n")) {
\t\t\t\tif (!line.startsWith("n/")) continue;
\t\t\t\tconst path = line.slice(1);
\t\t\t\tfor (const suffix of [".local/share/opencode", ".local/share/cortexkit/magic-context", ".config/opencode", ".config/cortexkit"]) {
\t\t\t\t\tconst forbidden = join(operator, suffix);
\t\t\t\t\tif (path === forbidden || path.startsWith(forbidden + "/")) throw new Error("operator path opened: " + path);
\t\t\t\t}
\t\t\t}
\t\t}
\t\tconst directory = process.env.MC_TX_HOST_PROOF_DIR!;
\t\tconst commit = valueAfter("--single-commit")!;
\t\twriteFileSync(join(directory, commit + "-lsof-context.txt"), proof.inventory);
\t\twriteFileSync(join(directory, commit + "-lsof-opencode.txt"), second.inventory);
\t\tconst main = RustTestHarness.prototype.mainRequests.call(harness);
\t\tfor (const request of main.slice(auditedMainRequests)) {
\t\t\tif (typeof request.rawBody !== "string") throw new Error("missing exact provider rawBody");
\t\t\tconst record = { commit, pass: ++auditedMainRequests, hostPid: pid,
\t\t\t\tfixtureRoot, databases: [...new Set([...proof.databases, ...second.databases])],
\t\t\t\tcontextInode: statSync(context).ino, opencodeInode: statSync(opencode).ino,
\t\t\t\tbytes: Buffer.byteLength(request.rawBody), rawBodySha256: hash(request.rawBody) };
\t\t\twriteFileSync(join(directory, "requests.jsonl"), JSON.stringify(record) + "\\n", { flag: "a" });
\t\t\twriteFileSync(join(directory, commit + "-" + auditedMainRequests + ".json"), request.rawBody);
\t\t}
\t};`);
    source = replaceExactly(source,
        "sendPrompt: (sessionId: string, text: string) =>\n\t\t\t\tharness.sendPrompt(sessionId, text, options),",
        "sendPrompt: async (sessionId: string, text: string) => {\n\t\t\t\tconst result = await harness.sendPrompt(sessionId, text, options);\n\t\t\t\tauditHost();\n\t\t\t\treturn result;\n\t\t\t},");
    writeFileSync(join(launcher, relative), source);
    console.log(execFileSync(process.execPath, [relative, "--ts-only", baseline, candidate], {
        cwd: launcher, env, encoding: "utf8", maxBuffer: 32 * 1024 * 1024,
    }));
    const records = readFileSync(join(proofDir, "requests.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line) as {
        commit: string; pass: number; hostPid: number; fixtureRoot: string; databases: string[];
        contextInode: number; opencodeInode: number; bytes: number; rawBodySha256: string;
    });
    const before = records.filter(record => record.commit === baseline);
    const after = records.filter(record => record.commit === candidate);
    if (before.length !== 6 || after.length !== 6) throw new Error(`expected six main requests per ref, got ${before.length}/${after.length}`);
    let identical = true;
    for (let index = 0; index < 6; index++) {
        const old = readFileSync(join(proofDir, `${baseline}-${index + 1}.json`));
        const next = readFileSync(join(proofDir, `${candidate}-${index + 1}.json`));
        const same = old.equals(next);
        identical &&= same;
        console.log(`RAW_BODY ${index + 1} ${same ? "IDENTICAL" : "DIVERGENT"} before=${before[index].bytes}/${before[index].rawBodySha256} after=${after[index].bytes}/${after[index].rawBodySha256}`);
    }
    for (const commit of [baseline, candidate]) {
        const refRecords = records.filter(record => record.commit === commit);
        console.log(`LSOF_PROOF ${JSON.stringify(refRecords)}`);
        for (const suffix of ["lsof-context", "lsof-opencode"]) {
            const inventory = readFileSync(join(proofDir, `${commit}-${suffix}.txt`), "utf8");
            console.log(`LSOF_INVENTORY commit=${commit} kind=${suffix} sha256=${createHash("sha256").update(inventory).digest("hex")}`);
        }
    }
    if (!identical) throw new Error("actual provider request bodies diverged; no cache_control or metadata normalization was applied");
    console.log("HOST_RESULT IDENTICAL: all six raw main request bodies per ref, including two warmups and four DEFER passes; lsof proved both database inodes in each isolated host");
} finally {
    rmSync(root, { recursive: true, force: true });
    console.log(`HOST_CLEANUP removed ${root}`);
}
