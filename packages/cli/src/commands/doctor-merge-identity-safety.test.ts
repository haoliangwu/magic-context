import { afterAll, afterEach, beforeAll, describe, expect, it, spyOn } from "bun:test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
    copyFileSync,
    mkdirSync,
    readdirSync,
    readFileSync,
    realpathSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { projectDirectoryKey } from "@magic-context/core/features/magic-context/memory/project-identity-cache";
import {
    initializeDatabase,
    runMigrations,
} from "@magic-context/core/features/magic-context/storage";
import { Database } from "@magic-context/core/shared/sqlite";
import { createTestTempDirFromPath } from "../../../plugin/src/shared/test-temp-dir";
import { formatIdentitySplits } from "./doctor-identity-splits";
import { runMergeIdentityCli } from "./doctor-merge-identity";

// Every path here lives under one throwaway root; no live store, config, or cache is read.
const root = realpathSync(createTestTempDirFromPath(join(tmpdir(), "mc-merge-safety-")));
const savedEnv: Record<string, string | undefined> = {};
const ISOLATED_ENV = {
    MAGIC_CONTEXT_STORAGE_DIR: join(root, "env-storage"),
    XDG_DATA_HOME: join(root, "xdg-data"),
    XDG_CONFIG_HOME: join(root, "xdg-config"),
    XDG_CACHE_HOME: join(root, "xdg-cache"),
};
let templatePath = "";
let fixtureCounter = 0;
const noHolderDeps = {
    inspectHolders: () => ({ safe: true, blockers: [] }),
    probe: () => ({ status: "free" as const }),
};

beforeAll(() => {
    for (const [key, value] of Object.entries(ISOLATED_ENV)) {
        savedEnv[key] = process.env[key];
        process.env[key] = value;
    }
    // Replaying the migration chain is slow, so build the schema once and copy it.
    templatePath = join(root, "template.db");
    const db = new Database(templatePath);
    initializeDatabase(db);
    runMigrations(db);
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    db.close();
}, 60_000);

afterAll(() => {
    for (const [key, value] of Object.entries(savedEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    }
    rmSync(root, { recursive: true, force: true });
});

let logSpy: ReturnType<typeof spyOn> | undefined;
afterEach(() => {
    logSpy?.mockRestore();
    logSpy = undefined;
});

function md5Identity(directory: string): string {
    return `dir:${createHash("md5").update(directory, "utf8").digest("hex").slice(0, 12)}`;
}

function gitIdentity(seed: string): string {
    return `git:${createHash("sha1").update(seed).digest("hex")}`;
}

function fileHash(path: string): string {
    return createHash("sha256").update(readFileSync(path)).digest("hex");
}

interface Store {
    storageDir: string;
    dbPath: string;
    db: Database;
    host: Database;
}

function newStore(): Store {
    const storageDir = join(root, `store-${++fixtureCounter}`);
    mkdirSync(storageDir, { recursive: true });
    const dbPath = join(storageDir, "context.db");
    copyFileSync(templatePath, dbPath);
    const host = new Database(join(storageDir, "host.db"));
    host.exec("CREATE TABLE session(id TEXT, directory TEXT)");
    return { storageDir, dbPath, db: new Database(dbPath), host };
}

function closeStore(store: Store): void {
    store.db.close();
    store.host.close();
}

/** A directory with content, so it is a live (non-leftover) project folder. */
function liveDirectory(name: string): string {
    const directory = join(root, `${name}-${++fixtureCounter}`);
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "README.md"), "fixture\n");
    return directory;
}

/** The project-identities sidecar the plugin writes after resolving a path to git. */
function persistIdentity(store: Store, directory: string, identity: string): void {
    const sidecars = join(store.storageDir, "project-identities");
    mkdirSync(sidecars, { recursive: true });
    const key = projectDirectoryKey(directory);
    writeFileSync(
        join(sidecars, `${createHash("sha256").update(key).digest("hex")}.json`),
        JSON.stringify({ directory: key, identity }),
    );
}

/** Record a host session in `directory` bound to `identity`. */
function bindSession(store: Store, sessionId: string, directory: string, identity: string): void {
    store.host.prepare("INSERT INTO session VALUES (?, ?)").run(sessionId, directory);
    store.db
        .prepare("INSERT INTO session_projects VALUES (?, 'opencode', ?, 1)")
        .run(sessionId, identity);
}

function seedRows(
    store: Store,
    identity: string,
    counts: { memories?: number; sessions?: number; dreamRuns?: number; tasks?: number },
): void {
    const { db } = store;
    db.prepare("INSERT OR IGNORE INTO project_state(project_path) VALUES (?)").run(identity);
    for (let i = 0; i < (counts.memories ?? 0); i++)
        db.prepare(
            "INSERT INTO memories(project_path, category, content, normalized_hash, first_seen_at, created_at, updated_at, last_seen_at) VALUES (?, 'fact', ?, ?, 1, 1, 1, 1)",
        ).run(identity, `${identity} memory ${i}`, `${identity}-${i}`);
    for (let i = 0; i < (counts.sessions ?? 0); i++)
        db.prepare("INSERT INTO session_projects VALUES (?, 'pi', ?, 1)").run(
            `${identity}-pi-${i}`,
            identity,
        );
    for (let i = 0; i < (counts.dreamRuns ?? 0); i++)
        db.prepare(
            "INSERT INTO dream_runs(project_path, started_at, finished_at, holder_id, tasks_json) VALUES (?, 1, 2, 'h', '[]')",
        ).run(identity);
    for (let i = 0; i < (counts.tasks ?? 0); i++)
        db.prepare("INSERT INTO task_schedule_state(project_path, task) VALUES (?, ?)").run(
            identity,
            `task-${i}`,
        );
}

function captureLog(): () => string {
    const lines: string[] = [];
    logSpy = spyOn(console, "log").mockImplementation((...args: unknown[]) => {
        lines.push(args.map(String).join(" "));
    });
    return () => lines.join("\n");
}

function proposalLines(output: string): string[] {
    return output.split("\n").filter((line) => line.includes("→"));
}

describe("doctor merge-identities on a removed worktree's leftover folder", () => {
    it("proposes nothing and refuses both pairs from the suggestion, even with --apply --force", () => {
        const store = newStore();
        // An empty folder with no .git, as a removed linked worktree leaves behind.
        const worktree = join(root, "worktree", `wt-${++fixtureCounter}`, "repo-variant");
        mkdirSync(worktree, { recursive: true });
        const repository = gitIdentity("issue-repo");
        // The plugin hashes the session's own spelling; on Windows that differs from the
        // normalized key doctor probes, which is why the source and target hashes differ.
        const smallSource = md5Identity(`${worktree}-original-spelling`);
        const liveTarget = md5Identity(projectDirectoryKey(worktree));
        persistIdentity(store, worktree, repository);
        seedRows(store, repository, { memories: 40, sessions: 30, dreamRuns: 12, tasks: 4 });
        bindSession(store, "wt-git", worktree, repository);
        seedRows(store, smallSource, { tasks: 3 });
        bindSession(store, "wt-dir", worktree, smallSource);
        closeStore(store);
        const before = fileHash(store.dbPath);

        const output = captureLog();
        expect(runMergeIdentityCli(["--db", store.dbPath])).toBe(0);
        expect(output()).toContain(`Orphaned project path: ${worktree}`);
        expect(output()).toContain(`Identity the plugin persisted for this path: ${repository}`);
        expect(proposalLines(output())).toEqual([]);

        for (const pair of [
            { from: repository, to: liveTarget, reason: "repository-wide identity" },
            { from: smallSource, to: liveTarget, reason: `target ${liveTarget} owns no rows` },
        ])
            for (const extra of [["--apply", "--force"], ["--force"], []])
                expect(() =>
                    runMergeIdentityCli(
                        ["--db", store.dbPath, "--from", pair.from, "--to", pair.to, ...extra],
                        noHolderDeps,
                    ),
                ).toThrow(pair.reason);
        expect(fileHash(store.dbPath)).toBe(before);
        expect(
            readdirSync(store.storageDir).filter((name) => name.startsWith("identity-merge")),
        ).toEqual([]);
    }, 30_000);
});

describe("doctor merge-identities safety rules", () => {
    it("never treats a repository-wide git identity as a source in an explicit merge", () => {
        const store = newStore();
        const repository = gitIdentity("rule-1-explicit");
        seedRows(store, repository, { memories: 2, sessions: 2 });
        seedRows(store, "dir:aaaaaaaaaaaa", { memories: 1 });
        closeStore(store);
        expect(() =>
            runMergeIdentityCli([
                "--db",
                store.dbPath,
                "--from",
                repository,
                "--to",
                "dir:aaaaaaaaaaaa",
                "--force",
            ]),
        ).toThrow("repository-wide identity");
    }, 30_000);

    it("never lists a repository-wide git identity as a split source", () => {
        const store = newStore();
        const directory = liveDirectory("rule-1-listing");
        const repository = gitIdentity("rule-1-listing");
        const live = md5Identity(directory);
        seedRows(store, repository, { memories: 3 });
        seedRows(store, live, { memories: 1 });
        bindSession(store, "git-session", directory, repository);
        bindSession(store, "dir-session", directory, live);
        closeStore(store);
        const output = captureLog();
        expect(runMergeIdentityCli(["--db", store.dbPath])).toBe(0);
        expect(output()).toContain(`${repository}: repository-wide identity`);
        expect(proposalLines(output())).toEqual([]);
    }, 30_000);

    it("refuses an explicit merge into a known target that owns no rows", () => {
        const store = newStore();
        seedRows(store, "dir:aaaaaaaaaaaa", { memories: 2 });
        // Known only from an earlier merge's history, it owns nothing now.
        store.db
            .prepare(
                "INSERT INTO v22_identity_rekey_map(old_project_path, new_project_path, rekeyed_at) VALUES ('dir:bbbbbbbbbbbb', 'dir:cccccccccccc', 1)",
            )
            .run();
        closeStore(store);
        expect(() =>
            runMergeIdentityCli([
                "--db",
                store.dbPath,
                "--from",
                "dir:aaaaaaaaaaaa",
                "--to",
                "dir:bbbbbbbbbbbb",
                "--force",
            ]),
        ).toThrow("target dir:bbbbbbbbbbbb owns no rows while dir:aaaaaaaaaaaa owns");
    }, 30_000);

    it("does not suggest a live target that owns no rows", () => {
        const store = newStore();
        const directory = liveDirectory("rule-2-listing");
        seedRows(store, "dir:aaaaaaaaaaaa", { memories: 2 });
        seedRows(store, "dir:bbbbbbbbbbbb", { tasks: 1 });
        bindSession(store, "a", directory, "dir:aaaaaaaaaaaa");
        bindSession(store, "b", directory, "dir:bbbbbbbbbbbb");
        closeStore(store);
        const output = captureLog();
        expect(runMergeIdentityCli(["--db", store.dbPath])).toBe(0);
        expect(output()).toContain(`Target ${md5Identity(directory)} owns no rows`);
        expect(proposalLines(output())).toEqual([]);
    }, 30_000);

    it("refuses an explicit merge that contradicts the identity persisted for the path", () => {
        const store = newStore();
        const directory = liveDirectory("rule-3-explicit");
        const persisted = gitIdentity("rule-3-explicit");
        const other = gitIdentity("rule-3-other");
        persistIdentity(store, directory, persisted);
        seedRows(store, persisted, { memories: 2 });
        seedRows(store, other, { memories: 1 });
        seedRows(store, "dir:aaaaaaaaaaaa", { memories: 1 });
        seedRows(store, "dir:bbbbbbbbbbbb", { memories: 1 });
        bindSession(store, "a", directory, "dir:aaaaaaaaaaaa");
        bindSession(store, "o", directory, other);
        closeStore(store);
        const merge = (from: string, to: string) => () =>
            runMergeIdentityCli(["--db", store.dbPath, "--from", from, "--to", to, "--force"]);
        expect(merge("dir:aaaaaaaaaaaa", "dir:bbbbbbbbbbbb")).toThrow(
            `the plugin persisted ${persisted} for ${projectDirectoryKey(directory)}`,
        );
        expect(merge(persisted, other)).toThrow(
            `${persisted} is the identity the plugin persisted for`,
        );
    }, 30_000);

    it("suggests the persisted identity over a disagreeing live resolution", () => {
        const store = newStore();
        const directory = liveDirectory("rule-3-listing");
        const persisted = gitIdentity("rule-3-listing");
        const live = md5Identity(directory);
        persistIdentity(store, directory, persisted);
        seedRows(store, persisted, { memories: 2 });
        seedRows(store, live, { memories: 1 });
        seedRows(store, "dir:aaaaaaaaaaaa", { memories: 1 });
        bindSession(store, "live", directory, live);
        bindSession(store, "a", directory, "dir:aaaaaaaaaaaa");
        closeStore(store);
        const output = captureLog();
        expect(runMergeIdentityCli(["--db", store.dbPath])).toBe(0);
        expect(output()).toContain(`Live resolution ${live} disagrees`);
        expect(proposalLines(output()).sort()).toEqual(
            [`  dir:aaaaaaaaaaaa → ${persisted}`, `  ${live} → ${persisted}`].sort(),
        );
    }, 30_000);

    it("reports a missing or empty git-less folder as orphaned instead of a split", () => {
        const store = newStore();
        const empty = join(root, `empty-${++fixtureCounter}`);
        mkdirSync(empty);
        const missing = join(root, `missing-${++fixtureCounter}`);
        const repository = gitIdentity("rule-4");
        seedRows(store, md5Identity(empty), { memories: 2 });
        seedRows(store, "dir:aaaaaaaaaaaa", { memories: 1 });
        seedRows(store, repository, { memories: 2 });
        seedRows(store, "dir:bbbbbbbbbbbb", { memories: 1 });
        bindSession(store, "e1", empty, md5Identity(empty));
        bindSession(store, "e2", empty, "dir:aaaaaaaaaaaa");
        bindSession(store, "m1", missing, repository);
        bindSession(store, "m2", missing, "dir:bbbbbbbbbbbb");
        closeStore(store);
        const output = captureLog();
        expect(runMergeIdentityCli(["--db", store.dbPath])).toBe(0);
        expect(output()).toContain(
            `Orphaned project path: ${empty} (directory is empty and has no git metadata)`,
        );
        expect(output()).toContain(
            `Orphaned project path: ${missing} (directory no longer exists)`,
        );
        expect(proposalLines(output())).toEqual([]);
        expect(formatIdentitySplits([{ directory: missing, identities: [] }]).join("\n")).toContain(
            `Orphaned project path: ${missing}`,
        );
    }, 30_000);
});

it("still merges two real directory splits into the persisted git identity that owns rows", () => {
    const store = newStore();
    const directory = liveDirectory("legit");
    execFileSync("git", ["init", "-q", directory], { stdio: "ignore", windowsHide: true });
    execFileSync(
        "git",
        [
            "-C",
            directory,
            "-c",
            "user.name=Fixture",
            "-c",
            "user.email=fixture@example.invalid",
            "commit",
            "--allow-empty",
            "-qm",
            "fixture",
        ],
        { stdio: "ignore", windowsHide: true },
    );
    const repository = `git:${execFileSync("git", ["-C", directory, "rev-parse", "HEAD"], { encoding: "utf8", windowsHide: true }).trim()}`;
    persistIdentity(store, directory, repository);
    seedRows(store, repository, { memories: 3 });
    bindSession(store, "g", directory, repository);
    seedRows(store, "dir:aaaaaaaaaaaa", { memories: 2 });
    seedRows(store, "dir:bbbbbbbbbbbb", { tasks: 1 });
    bindSession(store, "a", directory, "dir:aaaaaaaaaaaa");
    bindSession(store, "b", directory, "dir:bbbbbbbbbbbb");
    closeStore(store);

    const output = captureLog();
    expect(runMergeIdentityCli(["--db", store.dbPath])).toBe(0);
    expect(proposalLines(output()).sort()).toEqual([
        `  dir:aaaaaaaaaaaa → ${repository}`,
        `  dir:bbbbbbbbbbbb → ${repository}`,
    ]);
    for (const source of ["dir:aaaaaaaaaaaa", "dir:bbbbbbbbbbbb"])
        expect(
            runMergeIdentityCli(
                ["--db", store.dbPath, "--from", source, "--to", repository, "--apply"],
                noHolderDeps,
            ),
        ).toBe(0);

    const db = new Database(store.dbPath);
    try {
        expect(
            db
                .prepare(
                    "SELECT DISTINCT project_path FROM session_projects WHERE harness = 'opencode'",
                )
                .all(),
        ).toEqual([{ project_path: repository }]);
        expect(
            db.prepare("SELECT COUNT(*) AS n FROM memories WHERE project_path = ?").get(repository),
        ).toEqual({ n: 5 });
        expect(
            db
                .prepare("SELECT COUNT(*) AS n FROM task_schedule_state WHERE project_path = ?")
                .get(repository),
        ).toEqual({ n: 1 });
    } finally {
        db.close();
    }
}, 30_000);
