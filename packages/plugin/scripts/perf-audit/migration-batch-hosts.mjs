// Rehearse only on copied context.db and synthetic host stores. Compare literal
// provider bodies from the same warmed session snapshots, never normalized prompts.

import { Database } from "bun:sqlite";
import { strict as assert } from "node:assert";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
    chmodSync,
    existsSync,
    mkdirSync,
    readFileSync,
    realpathSync,
    rmSync,
    statSync,
    symlinkSync,
    writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { OpenCode } from "@opencode/client";
import { createOpencodeClient } from "@opencode-ai/sdk";
import { MockProvider } from "../../../e2e-tests/src/mock-provider/server";
import { awaitPluginActivation } from "../../../e2e-tests/src/opencode2-runner/plugin-activation";
import { CLI as V2_CLI } from "../../../e2e-tests/src/opencode2-runner/spawn";
import { runMigrations } from "../../src/features/magic-context/migrations";

const root = realpathSync(process.argv[2]);
assert.ok(root.startsWith(`${realpathSync(join(process.env.TMPDIR, "magic-context"))}/`));
const repo = resolve(import.meta.dir, "../../../..");
if (!existsSync(join(root, "node_modules")))
    symlinkSync(join(repo, "packages/plugin/node_modules"), join(root, "node_modules"));
const copy = (from, to) => {
    assert.ok(to.startsWith(`${root}/`), "only a throwaway destination may become writable");
    mkdirSync(resolve(to, ".."), { recursive: true });
    const child = spawnSync("timeout", ["60", "cp", "-c", from, to], { encoding: "utf8" });
    assert.equal(child.status, 0, child.stderr);
    // Backup specimens may be owner-read-only. Preserve the seed; make only
    // each disposable working clone writable for its host/migration.
    chmodSync(to, 0o600);
};
const sha = (text) => createHash("sha256").update(text).digest("hex");
function environment(lane, version) {
    const base = join(root, lane);
    mkdirSync(base, { recursive: true });
    const env = { PATH: process.env.PATH, OPENCODE_DISABLE_DEFAULT_PLUGINS: "true" };
    for (const name of [
        "HOME",
        "XDG_DATA_HOME",
        "XDG_CONFIG_HOME",
        "XDG_CACHE_HOME",
        "XDG_STATE_HOME",
        "XDG_RUNTIME_DIR",
        "TMPDIR",
    ]) {
        env[name] = join(base, name);
        mkdirSync(env[name], { recursive: true });
    }
    env.MAGIC_CONTEXT_STORAGE_DIR = join(base, "context");
    env.MAGIC_CONTEXT_LOG_PATH = join(base, "plugin.log");
    env.OPENCODE_DB = join(base, version === 1 ? "opencode.db" : "opencode2.db");
    const cwd = join(base, "project");
    mkdirSync(cwd, { recursive: true });
    return { base, env, cwd };
}
function inventory(pid) {
    const child = spawnSync("timeout", ["30", "lsof", "-g", String(pid), "-Fn"], {
        encoding: "utf8",
    });
    assert.equal(child.status, 0, child.stderr);
    writeFileSync(join(root, `lsof-${pid}.txt`), child.stdout);
    const paths = child.stdout
        .split("\n")
        .filter((s) => /^n.*\.db(?:-wal|-shm|-journal)?$/.test(s))
        .map((s) => s.slice(1));
    assert.ok(paths.length > 0);
    assert.ok(
        paths.every((path) => path.startsWith(`${root}/`)),
        JSON.stringify(paths),
    );
    return [...new Set(paths)];
}
const config = {
    auto_update: false,
    temporal_awareness: false,
    embedding: { provider: "off" },
    dreamer: { disable: true, inject_docs: false },
    historian: { disable: true },
    // Auto-search is independent of memory.enabled and depends on background indexing.
    // Disable it symmetrically, rather than strip a timing-dependent hint from a body.
    memory: { enabled: false, auto_search: { enabled: false } },
    compressor: { enabled: false },
};

async function host(version, fixture, entry, responseCounter = 0) {
    const mock = new MockProvider();
    mock.setDefault({ text: "fixture reply", usage: { input_tokens: 100, output_tokens: 10 } });
    let counter = responseCounter;
    mock.addMatcher((body) =>
        JSON.stringify(body).includes("MIG-WIRE")
            ? {
                  openaiOutput: [
                      {
                          id: `msg_migration_reply_${++counter}`,
                          type: "message",
                          role: "assistant",
                          content: [
                              {
                                  type: "output_text",
                                  text: "fixture reply",
                                  annotations: [],
                                  logprobs: [],
                              },
                          ],
                      },
                  ],
                  usage: { input_tokens: 100, output_tokens: 10 },
              }
            : null,
    );
    const upstream = await mock.start();
    const { env, cwd } = fixture;
    const provider = version === 1 ? "mock-anthropic" : "openai";
    const model = version === 1 ? "mock-sonnet" : "mock-model";
    const moduleDir = join(fixture.base, "probe-plugin");
    if (version === 2) {
        mkdirSync(moduleDir, { recursive: true });
        writeFileSync(
            join(moduleDir, "server.js"),
            `import mc from ${JSON.stringify(entry)}; export default {id:"opencode-magic-context",setup:mc.setup};`,
        );
    }
    const settings =
        version === 1
            ? {
                  plugin: [`file://${entry}`],
                  model: `${provider}/${model}`,
                  provider: {
                      [provider]: {
                          npm: "@ai-sdk/anthropic",
                          options: { baseURL: upstream.baseURL, apiKey: "mock-key" },
                          models: {
                              [model]: { name: model, limit: { context: 200000, output: 1024 } },
                          },
                      },
                  },
                  compaction: { auto: false },
              }
            : {
                  plugins: [moduleDir],
                  model: `${provider}/${model}`,
                  providers: {
                      [provider]: {
                          settings: { baseURL: upstream.baseURL, apiKey: "mock-key" },
                          models: {
                              [model]: { name: model, limit: { context: 200000, output: 1024 } },
                          },
                      },
                  },
                  compaction: { auto: false, buffer: 1024, keep: { tokens: 1024 } },
              };
    writeFileSync(join(cwd, "opencode.json"), JSON.stringify(settings));
    mkdirSync(join(env.XDG_CONFIG_HOME, "cortexkit"), { recursive: true });
    writeFileSync(
        join(env.XDG_CONFIG_HOME, "cortexkit/magic-context.jsonc"),
        JSON.stringify(config),
    );
    const cli = version === 1 ? "opencode" : V2_CLI;
    const v = spawnSync("timeout", ["30", cli, "--version"], { env, cwd, encoding: "utf8" });
    assert.equal(v.status, 0, v.stderr);
    assert.equal(v.stdout.trim().replace(/^opencode v/, ""), version === 1 ? "1.18.30" : "2.0.22");
    const child = spawn(
        "timeout",
        ["300", cli, "serve", "--hostname", "127.0.0.1", "--port", "0"],
        { env, cwd, detached: true, stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "",
        stderr = "";
    child.stderr.on("data", (data) => {
        stderr += data;
    });
    const listen = await new Promise((done, reject) => {
        const deadline = setTimeout(
            () => reject(new Error(`host listen deadline: ${stderr}`)),
            30000,
        );
        child.on("exit", (code) => {
            clearTimeout(deadline);
            reject(new Error(`host exited ${code}: ${stderr}`));
        });
        child.stdout.on("data", (data) => {
            stdout += data;
            const url = stdout.match(/server listening on (https?:\/\/\S+)/)?.[1];
            const password = stdout.match(/server password (\S+)/)?.[1];
            if (url && (version === 1 || password)) {
                clearTimeout(deadline);
                done({ url, password });
            }
        });
    });
    const headers =
        version === 2 ? { authorization: `Basic ${btoa(`opencode:${listen.password}`)}` } : {};
    const client =
        version === 1
            ? createOpencodeClient({ baseUrl: listen.url, directory: cwd })
            : OpenCode.make({ baseUrl: listen.url, headers });
    const samples = [];
    const sampler = spawn(
        "timeout",
        [
            "300",
            process.execPath,
            join(import.meta.dir, "migration-batch-health-probe.mjs"),
            listen.url,
            JSON.stringify(headers),
        ],
        { env, cwd, stdio: ["pipe", "pipe", "pipe"] },
    );
    let samplerOutput = "",
        samplerError = "";
    let markPrimed;
    const primed = new Promise((done) => {
        markPrimed = done;
    });
    sampler.stdout.on("data", (data) => {
        samplerOutput += String(data);
        let newline;
        while ((newline = samplerOutput.indexOf("\n")) >= 0) {
            const message = JSON.parse(samplerOutput.slice(0, newline));
            samplerOutput = samplerOutput.slice(newline + 1);
            if (message.type === "primed") markPrimed();
            else samples.push(message);
        }
    });
    sampler.stderr.on("data", (data) => {
        samplerError += String(data);
    });
    const samplerClosed = new Promise((done) => sampler.once("close", done));
    const priming = setTimeout(() => sampler.stdin.end("stop\n"), 10000);
    const first = await Promise.race([
        primed.then(() => "primed"),
        samplerClosed.then(() => "closed"),
    ]);
    clearTimeout(priming);
    assert.equal(first, "primed", `health sampler could not prime: ${samplerError}`);
    const ready = async () => {
        if (version === 2)
            await awaitPluginActivation(client, cwd, "opencode-magic-context", 60000);
    };
    const create = async () => {
        if (version === 2) {
            await ready();
            return (
                await client.session.create({
                    title: "Migration wire",
                    location: { directory: cwd },
                    model: { providerID: provider, id: model },
                })
            ).id;
        }
        const result = await client.session.create({ body: { title: "Migration wire" } });
        assert.ok(!result.error, JSON.stringify(result.error));
        return result.data.id;
    };
    const prompt = async (sessionID, text) => {
        if (version === 2) {
            await client.session.prompt({ sessionID, text });
            await client.session.wait({ sessionID }, { signal: AbortSignal.timeout(60000) });
        } else {
            const result = await client.session.prompt({
                path: { id: sessionID },
                body: {
                    model: { providerID: provider, modelID: model },
                    parts: [{ type: "text", text }],
                },
            });
            assert.ok(!result.error, JSON.stringify(result.error));
        }
    };
    const stopSampling = async () => {
        if (!sampler.stdin.destroyed) sampler.stdin.end("stop\n");
        const code = await samplerClosed;
        assert.equal(code, 0, samplerError);
    };
    const stop = async () => {
        await stopSampling();
        const exited = new Promise((done) => child.once("close", done));
        try {
            process.kill(-child.pid, "SIGTERM");
        } catch {}
        await exited;
        await mock.stop();
    };
    return {
        ...listen,
        child,
        client,
        mock,
        create,
        ready,
        prompt,
        samples,
        samplerPid: sampler.pid,
        stopSampling,
        stop,
        counter: () => counter,
        logs: () =>
            existsSync(env.MAGIC_CONTEXT_LOG_PATH)
                ? readFileSync(env.MAGIC_CONTEXT_LOG_PATH, "utf8")
                : "",
        stderr: () => stderr,
    };
}

// Time the actual runner and independently hash the unmodified durable data.
let report;
if (process.argv.includes("--skip-rehearsal")) {
    report = JSON.parse(readFileSync(join(root, "hosts.json"), "utf8"));
} else {
    const rehearsal = join(root, "rehearsal.db");
    copy(join(root, "context.db"), rehearsal);
    const db = new Database(rehearsal);
    db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA foreign_keys=ON");
    const digest = (table, order) => {
        const hash = createHash("sha256");
        let rows = 0;
        for (const row of db
            .query(
                `SELECT ${table === "git_commits_fts" ? "rowid,*" : "*"} FROM ${table} ORDER BY ${order}`,
            )
            .iterate()) {
            hash.update(JSON.stringify(row));
            hash.update("\n");
            rows++;
        }
        return { rows, sha256: hash.digest("hex") };
    };
    const before = Object.fromEntries(
        [
            ["session_meta", "session_id"],
            ["tags", "id"],
            ["git_commits_fts", "rowid"],
        ].map(([table, order]) => [table, digest(table, order)]),
    );
    const fkBefore = db.query("PRAGMA foreign_key_check").all();
    const start = performance.now();
    runMigrations(db);
    const durationMs = performance.now() - start;
    const after = Object.fromEntries(
        [
            ["session_meta", "session_id"],
            ["tags", "id"],
            ["git_commits_fts", "rowid"],
        ].map(([table, order]) => [table, digest(table, order)]),
    );
    assert.deepEqual(after, before);
    assert.deepEqual(db.query("PRAGMA foreign_key_check").all(), fkBefore);
    assert.deepEqual(db.query("PRAGMA quick_check").get(), { quick_check: "ok" });
    assert.equal(
        db.query("SELECT MAX(version) AS v FROM schema_migrations WHERE version<10000").get().v,
        95,
    );
    assert.equal(
        db.query("SELECT COUNT(*) AS n FROM git_commit_fts_rowid_map").get().n,
        before.git_commits_fts.rows,
    );
    const secondStart = performance.now();
    runMigrations(db);
    const noOpMs = performance.now() - secondStart;
    db.close();
    report = {
        bun: Bun.version,
        durationMs,
        noOpMs,
        durable: after,
        foreignKeyViolations: fkBefore.length,
        health: [],
        wire: [],
    };
    console.log(JSON.stringify({ stage: "rehearsal", ...report }));
    writeFileSync(join(root, "hosts.json"), JSON.stringify(report, null, 2));
}

function contextCounts(path) {
    const connection = new Database(path, { readonly: true });
    try {
        return {
            schema: connection
                .query("SELECT MAX(version) AS n FROM schema_migrations WHERE version<10000")
                .get().n,
            tags: connection.query("SELECT count(*) AS n FROM tags").get().n,
            messageMap: connection.query("SELECT count(*) AS n FROM message_fts_rowid_map").get().n,
            gitFts: connection.query("SELECT count(*) AS n FROM git_commits_fts").get().n,
        };
    } finally {
        connection.close();
    }
}
const expectedCounts = contextCounts(join(root, "context.db"));
if (process.argv.includes("--full-size-health")) {
    const seed = statSync(join(root, "context.db"));
    assert.ok((seed.mode & 0o222) === 0, "full-size-host-read-only-seed");
    assert.ok(
        seed.size >= 5 * 1024 ** 3 &&
            expectedCounts.schema === 94 &&
            expectedCounts.tags >= 2_000_000 &&
            expectedCounts.messageMap >= 300_000 &&
            expectedCounts.gitFts >= 40_000,
        "full-size-host-seed-corpus-floor",
    );
}
const healthCases = [1, 2].flatMap((version) =>
    process.argv.includes("--full-size-health")
        ? [
              { version, holder: false },
              { version, holder: true },
          ]
        : [{ version, holder: false }],
);
for (const { version, holder } of healthCases) {
    if (process.argv.includes("--wire-only")) continue;
    if (version === 1 && process.argv.includes("--skip-health-v1")) continue;
    if (version === 1 && !holder && process.argv.includes("--skip-single-v1")) continue;
    const label = `health-v${version}${holder ? "-reader-holder" : ""}`;
    const fixture = environment(label, version);
    const logStart = existsSync(fixture.env.MAGIC_CONTEXT_LOG_PATH)
        ? readFileSync(fixture.env.MAGIC_CONTEXT_LOG_PATH, "utf8").length
        : 0;
    const contextPath = join(fixture.env.MAGIC_CONTEXT_STORAGE_DIR, "context.db");
    for (const suffix of ["", "-wal", "-shm"]) rmSync(contextPath + suffix, { force: true });
    copy(join(root, "context.db"), contextPath);
    if (existsSync(join(root, "store.db"))) {
        const storePath = join(fixture.env.MAGIC_CONTEXT_STORAGE_DIR, "store.db");
        for (const suffix of ["", "-wal", "-shm"]) rmSync(storePath + suffix, { force: true });
        copy(join(root, "store.db"), storePath);
    }
    const startingCounts = contextCounts(contextPath);
    assert.deepEqual(startingCounts, expectedCounts);
    let holderProcess,
        holderFiles = [];
    if (holder) {
        const connection = new Database(contextPath);
        connection.exec("PRAGMA journal_mode=WAL");
        connection.close();
        holderProcess = spawn(
            "timeout",
            [
                "180",
                process.execPath,
                "--eval",
                `import {Database} from "bun:sqlite";const db=new Database(${JSON.stringify(contextPath)});db.exec("BEGIN");db.query("SELECT MAX(version) FROM schema_migrations").get();console.log("READER_READY");setInterval(()=>{},1000);`,
            ],
            {
                env: fixture.env,
                cwd: fixture.cwd,
                detached: true,
                stdio: ["ignore", "pipe", "pipe"],
            },
        );
        let holderError = "";
        holderProcess.stderr.on("data", (data) => {
            holderError += data;
        });
        await new Promise((done, reject) => {
            const t = setTimeout(() => reject(new Error("reader-holder deadline")), 10000);
            holderProcess.stdout.on("data", (data) => {
                if (String(data).includes("READER_READY")) {
                    clearTimeout(t);
                    done();
                }
            });
            holderProcess.on("exit", (code) => {
                clearTimeout(t);
                reject(new Error(`reader-holder exit ${code}: ${holderError}`));
            });
        });
        holderFiles = inventory(holderProcess.pid);
    }
    let server;
    try {
        server = await host(
            version,
            fixture,
            join(
                repo,
                version === 1
                    ? "packages/plugin/dist/index.js"
                    : "packages/plugin/dist/v2/server.js",
            ),
        );
        await server.create();
        await new Promise((done) => setTimeout(done, 1500));
        await server.stopSampling();
        const logs = server.logs().slice(logStart);
        assert.ok(logs.includes("applied v95"), logs + server.stderr());
        assert.ok(logs.includes("applying pending migrations on a worker thread"), logs);
        assert.ok(!logs.includes("applying migrations on the main thread"), logs);
        assert.ok(server.samples.length >= 3);
        // Separate host/module loading from the migration interval. Keep all startup
        // failures in the record, but the responsiveness requirement is while v95 runs.
        const timestamp = (fragment) =>
            Date.parse(
                logs
                    .split("\n")
                    .find((line) => line.includes(fragment))
                    ?.match(/^\[([^\]]+)\]/)?.[1] ?? "",
            );
        const migrationStart = timestamp("current upstream migration lane: 94");
        const commitAt = timestamp("applied v95");
        const workerStart = timestamp("applying pending migrations on a worker thread");
        const workerReady = timestamp("migration worker ready");
        const migrationEnd = timestamp("migration worker connection closed");
        assert.ok(
            Number.isFinite(workerStart) &&
                workerReady >= workerStart &&
                migrationStart >= workerStart &&
                migrationEnd >= commitAt &&
                commitAt >= migrationStart,
        );
        assert.ok(/async open main-thread migration-body count: 0 \(total=0\)/.test(logs), logs);
        const live = server.samples.filter(
            (s) => s.wallStarted <= migrationEnd && s.wallEnded >= migrationStart,
        );
        const completed = server.samples
            .filter((s) => !s.error && s.status === 200)
            .map((s) => s.wallEnded)
            .sort((a, b) => a - b);
        assert.ok(
            completed[0] < migrationStart && completed.at(-1) > migrationEnd,
            "health must bracket the measured migration",
        );
        assert.ok(live.length > 0, "no health probe reached the migration interval");
        const gaps = completed
            .slice(1)
            .map((t, i) => ({ start: completed[i], end: t, gap: t - completed[i] }));
        const overlapping = gaps.filter(
            (gap) => gap.end >= migrationStart && gap.start <= migrationEnd,
        );
        assert.ok(overlapping.length > 0);
        const longestGapMs = Math.max(...overlapping.map((gap) => gap.gap));
        const workerGaps = gaps.filter(
            (gap) => gap.end >= workerStart && gap.start <= migrationEnd,
        );
        assert.ok(
            completed[0] < workerStart && completed.at(-1) > migrationEnd,
            "health must bracket worker start through close, including module loading",
        );
        const workerLongestGapMs = Math.max(...workerGaps.map((gap) => gap.gap));
        const hostCounts = contextCounts(contextPath);
        assert.deepEqual(hostCounts, { ...expectedCounts, schema: 95 });
        writeFileSync(
            join(root, `${label}-samples.json`),
            JSON.stringify(
                {
                    workerStart,
                    workerReady,
                    migrationStart,
                    commitAt,
                    migrationEnd,
                    samples: server.samples,
                },
                null,
                2,
            ),
        );
        const files = inventory(server.child.pid);
        const result = {
            version,
            label,
            holder,
            startingCounts,
            hostCounts,
            holderFiles,
            hostGroupPid: server.child.pid,
            samplerPid: server.samplerPid,
            holderGroupPid: holderProcess?.pid ?? null,
            mainThreadMigrationBodies: 0,
            workerStart,
            workerReady,
            commitAt,
            workerClosedAt: migrationEnd,
            probes: server.samples.length,
            migrationProbes: live.length,
            migrationHealthFailures: live.filter((s) => s.error || s.status !== 200).length,
            migrationDurationMs: migrationEnd - migrationStart,
            wholeBootFailures: server.samples.filter((s) => s.error || s.status !== 200).length,
            wholeBootLongestGapMs: Math.max(...gaps.map((gap) => gap.gap)),
            longestGapMs,
            workerLongestGapMs,
            files,
            migrationLogs: logs
                .split("\n")
                .filter(
                    (line) => line.includes("[migrations]") || line.includes("migration-runner"),
                ),
        };
        report.health.push(result);
        console.log(JSON.stringify({ stage: "health", ...result }));
        writeFileSync(join(root, "hosts.json"), JSON.stringify(report, null, 2));
        await server.stop();
        server = undefined;
        if (holderProcess) {
            const ended = new Promise((done) => holderProcess.once("close", done));
            process.kill(-holderProcess.pid, "SIGTERM");
            await ended;
            holderProcess = undefined;
        }
        const restartOffset = existsSync(fixture.env.MAGIC_CONTEXT_LOG_PATH)
            ? readFileSync(fixture.env.MAGIC_CONTEXT_LOG_PATH, "utf8").length
            : 0;
        server = await host(
            version,
            fixture,
            join(
                repo,
                version === 1
                    ? "packages/plugin/dist/index.js"
                    : "packages/plugin/dist/v2/server.js",
            ),
        );
        await server.create();
        await new Promise((done) => setTimeout(done, 1500));
        await server.stopSampling();
        const restartLogs = server.logs().slice(restartOffset);
        assert.ok(
            !restartLogs.includes("applying pending migrations on a worker thread") &&
                !restartLogs.includes("applied v95"),
            restartLogs,
        );
        assert.ok(
            /async open main-thread migration-body count: 0 \(total=0\)/.test(restartLogs),
            restartLogs,
        );
        const successful = server.samples
            .filter((s) => !s.error && s.status === 200)
            .map((s) => s.wallEnded)
            .sort((a, b) => a - b);
        const restartCounts = contextCounts(contextPath);
        assert.deepEqual(restartCounts, { ...expectedCounts, schema: 95 });
        const restart = {
            label,
            version,
            probes: server.samples.length,
            failures: server.samples.length - successful.length,
            longestGapMs: Math.max(...successful.slice(1).map((t, i) => t - successful[i])),
            mainThreadMigrationBodies: 0,
            counts: restartCounts,
            hostGroupPid: server.child.pid,
            samplerPid: server.samplerPid,
            files: inventory(server.child.pid),
        };
        result.restart = restart;
        console.log(JSON.stringify({ stage: "restart", ...restart }));
        writeFileSync(join(root, "hosts.json"), JSON.stringify(report, null, 2));
    } finally {
        await server?.stop();
        if (holderProcess) {
            const ended = new Promise((done) => holderProcess.once("close", done));
            try {
                process.kill(-holderProcess.pid, "SIGTERM");
            } catch {}
            await ended;
        }
    }
}

for (const version of [1, 2]) {
    if (process.argv.includes("--health-only")) continue;
    rmSync(join(root, `wire-v${version}`), { recursive: true, force: true });
    const fixture = environment(`wire-v${version}`, version);
    const base = join(
        root,
        version === 1 ? "baseline-dist/index.js" : "baseline-dist/v2/server.js",
    );
    const candidate = join(
        repo,
        version === 1 ? "packages/plugin/dist/index.js" : "packages/plugin/dist/v2/server.js",
    );
    let id, snapshots, baseline, responseCounter, warmedHead;
    const head = () => {
        const connection = new Database(join(fixture.env.MAGIC_CONTEXT_STORAGE_DIR, "context.db"), {
            readonly: true,
        });
        try {
            const row = connection
                .query(
                    "SELECT cached_m0_bytes,cached_m1_bytes,cached_m0_materialized_at FROM session_meta WHERE session_id=?",
                )
                .get(id);
            assert.ok(
                row?.cached_m0_bytes?.byteLength > 0 && row?.cached_m1_bytes?.byteLength > 0,
                "wire must exercise a persisted warmed head",
            );
            return {
                m0: sha(Buffer.from(row.cached_m0_bytes)),
                m1: sha(Buffer.from(row.cached_m1_bytes)),
                materializedAt: row.cached_m0_materialized_at,
            };
        } finally {
            connection.close();
        }
    };
    for (const arm of ["baseline", "candidate"]) {
        let server;
        try {
            server = await host(
                version,
                fixture,
                arm === "baseline" ? base : candidate,
                arm === "baseline" ? 0 : responseCounter,
            );
            if (arm === "baseline") {
                id = await server.create();
                await server.prompt(id, "MIG-WIRE warmup");
                warmedHead = head();
                responseCounter = server.counter();
                const files = inventory(server.child.pid).filter((path) => path.endsWith(".db"));
                snapshots = files.map((path, i) => {
                    const snapshot = join(root, `wire-v${version}-seed-${i}.db`);
                    rmSync(snapshot, { force: true });
                    const connection = new Database(path, { readonly: true });
                    try {
                        connection.query("VACUUM INTO ?").run(snapshot);
                    } finally {
                        connection.close();
                    }
                    return { path, snapshot };
                });
            }
            const offset = server.mock.requests().length;
            for (let i = 0; i < 3; i++) await server.prompt(id, `MIG-WIRE defer ${i}`);
            assert.deepEqual(
                head(),
                warmedHead,
                "pure defers must retain the warmed head and materialization stamp",
            );
            if (version === 2)
                await server.client.session.command({ sessionID: id, name: "ctx-flush", text: "" });
            else
                await server.client.session.command({
                    path: { id },
                    body: { command: "ctx-flush", arguments: "" },
                });
            await server.prompt(id, "MIG-WIRE priced flush");
            const bodies = server.mock
                .requests()
                .slice(offset)
                .map((request) => request.rawBody)
                .filter((body) => body.includes("MIG-WIRE"));
            assert.ok(bodies.length >= 4, `${arm}: only ${bodies.length} bodies`);
            const files = inventory(server.child.pid);
            const beforeRestart = head();
            const counterAtRestart = server.counter();
            const logOffset = server.logs().length;
            await server.stop();
            server = undefined;
            server = await host(
                version,
                fixture,
                arm === "baseline" ? base : candidate,
                counterAtRestart,
            );
            await server.ready();
            await server.prompt(id, "MIG-WIRE restart defer");
            assert.deepEqual(head(), beforeRestart, "restart must replay the existing head");
            assert.ok(
                !server.logs().slice(logOffset).includes("applied v95"),
                "current restart must not migrate",
            );
            files.push(...inventory(server.child.pid));
            bodies.push(
                ...server.mock
                    .requests()
                    .map((request) => request.rawBody)
                    .filter((body) => body.includes("MIG-WIRE")),
            );
            if (arm === "baseline") baseline = bodies;
            else {
                assert.deepEqual(bodies, baseline, "literal provider HTTP bodies differ");
                const result = {
                    version,
                    comparisons: bodies.length,
                    files,
                    bodies: bodies.map((body) => ({
                        bytes: Buffer.byteLength(body),
                        sha256: sha(body),
                    })),
                };
                report.wire.push(result);
                console.log(JSON.stringify({ stage: "wire", ...result }));
            }
        } finally {
            await server?.stop();
        }
        if (arm === "baseline") {
            for (const name of [
                "HOME",
                "XDG_DATA_HOME",
                "XDG_CONFIG_HOME",
                "XDG_CACHE_HOME",
                "XDG_STATE_HOME",
                "XDG_RUNTIME_DIR",
                "TMPDIR",
            ]) {
                rmSync(fixture.env[name], { recursive: true, force: true });
                mkdirSync(fixture.env[name], { recursive: true });
            }
            rmSync(fixture.env.MAGIC_CONTEXT_STORAGE_DIR, { recursive: true, force: true });
            for (const { path, snapshot } of snapshots) {
                for (const suffix of ["", "-wal", "-shm"]) rmSync(path + suffix, { force: true });
                copy(snapshot, path);
            }
        }
    }
}
// Record every holder/restart lane before failing a responsiveness budget. A
// long post-close initialization gap must not erase the remaining measurements.
report.healthBudgetViolations = report.health
    .filter(
        (lane) =>
            lane.migrationHealthFailures > 0 ||
            lane.longestGapMs > 1000 ||
            lane.workerLongestGapMs > 1000 ||
            lane.restart.failures > 0 ||
            lane.restart.longestGapMs > 1000,
    )
    .map((lane) => lane.label);
writeFileSync(join(root, "hosts.json"), JSON.stringify(report, null, 2));
assert.deepEqual(report.healthBudgetViolations, [], "one-second host health budget exceeded");
console.log(
    `PASS: one large-copy migration, ${report.health.length} recorded off-thread health lanes and ${report.wire.reduce((n, arm) => n + arm.comparisons, 0)} literal real-host wire comparisons`,
);
